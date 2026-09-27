use std::{path::Path, process::Stdio, time::Duration};

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{ChildStdin, ChildStdout, Command},
    time::timeout,
};

use crate::config::AgentConfig;

use super::HarnessAdapter;

type RpcLines = Lines<BufReader<ChildStdout>>;

#[derive(Debug, Clone)]
pub struct OmpAdapter {
    binary: String,
}

impl OmpAdapter {
    pub fn new(binary: String) -> Self {
        Self { binary }
    }

    fn agent_args(&self, agent: &AgentConfig) -> Vec<String> {
        let mut args = vec![
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

        if let Some(reasoning) = agent
            .reasoning
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            args.push("--thinking".into());
            args.push(reasoning.into());
        }

        args
    }

    fn headless_args_for(&self, agent: &AgentConfig, input: &str) -> Vec<String> {
        let mut args = vec!["--mode".to_string(), "text".to_string()];
        args.extend(self.agent_args(agent));
        args.push("-p".into());
        args.push(input.into());
        args
    }

    fn rpc_args_for(&self, agent: &AgentConfig) -> Vec<String> {
        let mut args = vec![
            "--mode".to_string(),
            "rpc".to_string(),
            "--no-ui".to_string(),
            "--no-session".to_string(),
        ];
        args.extend(self.agent_args(agent));
        args
    }

    async fn invoke_headless(&self, agent: &AgentConfig, input: &str) -> Result<String> {
        let output = Command::new(&self.binary)
            .args(self.headless_args_for(agent, input))
            .current_dir(&agent.workspace)
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

    async fn invoke_rpc(&self, agent: &AgentConfig, input: &str, fast: bool) -> Result<String> {
        let mut child = Command::new(&self.binary)
            .args(self.rpc_args_for(agent))
            .current_dir(&agent.workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| {
                format!(
                    "failed to start OMP RPC for '{}'; is '{}' installed and on PATH?",
                    agent.name, self.binary
                )
            })?;

        let mut stdin = child
            .stdin
            .take()
            .context("OMP RPC did not provide stdin")?;
        let stdout = child
            .stdout
            .take()
            .context("OMP RPC did not provide stdout")?;
        let mut lines = BufReader::new(stdout).lines();

        self.wait_for_ready(agent, &mut lines).await?;

        Self::send_rpc(
            &mut stdin,
            &json!({
                "id": "hivemind_fast",
                "type": "set_fast_mode",
                "enabled": fast
            }),
        )
        .await?;
        self.wait_for_response(agent, &mut lines, "hivemind_fast", "set_fast_mode")
            .await?;

        Self::send_rpc(
            &mut stdin,
            &json!({
                "id": "hivemind_prompt",
                "type": "prompt",
                "message": input
            }),
        )
        .await?;

        let settled = self
            .wait_for_prompt_result(agent, &mut lines, "hivemind_prompt")
            .await?;

        if !settled {
            self.wait_for_session_settled(agent, &mut lines).await?;
        }

        Self::send_rpc(
            &mut stdin,
            &json!({
                "id": "hivemind_last_text",
                "type": "get_last_assistant_text"
            }),
        )
        .await?;

        let response = self
            .wait_for_response(
                agent,
                &mut lines,
                "hivemind_last_text",
                "get_last_assistant_text",
            )
            .await?;

        let text = response
            .get("data")
            .and_then(|data| data.get("text"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .context("OMP RPC completed without assistant text")?
            .to_string();

        drop(stdin);
        drop(lines);

        match timeout(Duration::from_secs(2), child.wait()).await {
            Ok(result) => {
                let _ = result;
            }
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }

        Ok(text)
    }

    async fn wait_for_ready(&self, agent: &AgentConfig, lines: &mut RpcLines) -> Result<()> {
        loop {
            let frame = Self::next_rpc_frame(agent, lines).await?;

            if frame.get("type").and_then(Value::as_str) == Some("ready") {
                return Ok(());
            }
        }
    }

    async fn wait_for_response(
        &self,
        agent: &AgentConfig,
        lines: &mut RpcLines,
        request_id: &str,
        command: &str,
    ) -> Result<Value> {
        loop {
            let frame = Self::next_rpc_frame(agent, lines).await?;

            if frame.get("type").and_then(Value::as_str) != Some("response")
                || frame.get("id").and_then(Value::as_str) != Some(request_id)
            {
                continue;
            }

            if frame.get("success").and_then(Value::as_bool) == Some(true) {
                return Ok(frame);
            }

            let error = frame
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown RPC error");

            bail!("OMP RPC {command} failed for '{}': {error}", agent.name);
        }
    }

    async fn wait_for_prompt_result(
        &self,
        agent: &AgentConfig,
        lines: &mut RpcLines,
        request_id: &str,
    ) -> Result<bool> {
        loop {
            let frame = Self::next_rpc_frame(agent, lines).await?;
            let frame_type = frame.get("type").and_then(Value::as_str);

            if frame_type == Some("response")
                && frame.get("id").and_then(Value::as_str) == Some(request_id)
            {
                if frame.get("success").and_then(Value::as_bool) != Some(true) {
                    let error = frame
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown RPC error");
                    bail!("OMP RPC prompt failed for '{}': {error}", agent.name);
                }

                if frame
                    .get("data")
                    .and_then(|data| data.get("agentInvoked"))
                    .and_then(Value::as_bool)
                    == Some(false)
                {
                    bail!(
                        "OMP RPC prompt for '{}' completed without invoking an agent",
                        agent.name
                    );
                }
            }

            if frame_type != Some("prompt_result")
                || frame.get("id").and_then(Value::as_str) != Some(request_id)
            {
                continue;
            }

            match frame.get("status").and_then(Value::as_str) {
                Some("completed") => {
                    return Ok(frame
                        .get("sessionSettled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false));
                }
                Some("error") => {
                    let error = frame
                        .get("error")
                        .and_then(|value| value.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("unknown provider error");
                    bail!("OMP provider failed for '{}': {error}", agent.name);
                }
                Some("aborted") => {
                    bail!("OMP prompt was aborted for '{}'", agent.name);
                }
                Some(status) => {
                    bail!(
                        "OMP returned unexpected prompt status '{status}' for '{}'",
                        agent.name
                    );
                }
                None => {
                    bail!("OMP prompt result for '{}' had no status", agent.name);
                }
            }
        }
    }

    async fn wait_for_session_settled(
        &self,
        agent: &AgentConfig,
        lines: &mut RpcLines,
    ) -> Result<()> {
        loop {
            let frame = Self::next_rpc_frame(agent, lines).await?;

            if frame.get("type").and_then(Value::as_str) == Some("session_settled") {
                return Ok(());
            }
        }
    }

    async fn next_rpc_frame(agent: &AgentConfig, lines: &mut RpcLines) -> Result<Value> {
        let line = lines
            .next_line()
            .await
            .with_context(|| format!("failed reading OMP RPC output for '{}'", agent.name))?
            .with_context(|| format!("OMP RPC exited before '{}' completed", agent.name))?;

        serde_json::from_str(&line)
            .with_context(|| format!("OMP RPC returned invalid JSON for '{}': {line}", agent.name))
    }

    async fn send_rpc(stdin: &mut ChildStdin, frame: &Value) -> Result<()> {
        let mut payload = serde_json::to_vec(frame).context("failed to encode OMP RPC command")?;
        payload.push(b'\n');

        stdin
            .write_all(&payload)
            .await
            .context("failed to write OMP RPC command")?;
        stdin
            .flush()
            .await
            .context("failed to flush OMP RPC command")?;

        Ok(())
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

        match agent.fast {
            Some(fast) => self.invoke_rpc(agent, input, fast).await,
            None => self.invoke_headless(agent, input).await,
        }
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
            reasoning: Some("high".into()),
            fast: None,
        }
    }

    #[test]
    fn headless_args_include_model_and_reasoning() {
        let adapter = OmpAdapter::new("omp".into());
        let args = adapter.headless_args_for(&agent(), "hello");

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

    #[test]
    fn rpc_args_keep_model_and_reasoning_on_the_agent_process() {
        let adapter = OmpAdapter::new("omp".into());
        let args = adapter.rpc_args_for(&agent());

        assert_eq!(
            args,
            vec![
                "--mode",
                "rpc",
                "--no-ui",
                "--no-session",
                "--append-system-prompt",
                "You are Maomao.",
                "--model",
                "example-model",
                "--thinking",
                "high",
            ]
        );
    }
}
