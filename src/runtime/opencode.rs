//! OpenCode adapter over the Agent Client Protocol (ACP).
//!
//! Transport, chosen by experiment against OpenCode v2.0.18:
//! `opencode acp` speaks newline-delimited JSON-RPC on stdio, so it reuses the
//! same child-transport shape as Pi/OMP (no port, no password, no HTTP) and
//! keeps context in the live process. `opencode run` per turn was rejected
//! (cold start, on-disk session state); `opencode serve` needs a loopback port
//! plus a secret for no gain.
//!
//! Verified behavior the adapter relies on:
//! - `initialize` -> `session/new {cwd}` -> `session/set_config_option`
//!   (`model`, value `provider/model`) -> `session/prompt`; the prompt request
//!   resolves with `stopReason` after streaming `session/update` notifications.
//! - Reply text is the `agent_message_chunk`s; reasoning arrives as
//!   `agent_thought_chunk` and is ignored. Chunks carry a `messageId`; a turn
//!   with tool calls has several assistant messages, and the reply is the last
//!   one with text (same as Pi/OMP "last assistant text").
//! - Context size is the latest `usage_update.used`.
//! - ACP has no system-prompt field, so the agent's system prompt replaces the
//!   `build` agent prompt through the `OPENCODE_CONFIG_CONTENT` environment
//!   variable of the child.
//! - Permissions: Hivemind has no human in the loop, so the child config sets
//!   `"permission": "allow"` (verified: reads outside the workspace then raise
//!   no request). This matches Pi/OMP, which run tools without approval. As a
//!   fallback, any `session/request_permission` that still arrives is
//!   answered with the `allow_once` option.
//! - `session/delete` removes the on-disk session; closing stdin makes `acp`
//!   and its private `serve --stdio` child exit. SIGKILL of the `acp` child
//!   left no `opencode` or tool grandchild behind. The process name in `ps` is
//!   `opencode` (`opencode.exe` for the inner server).
//!
//! Dropping a prompt future leaves the ACP session busy; the pool discards a
//! session whose prompt was cancelled, and `kill_on_drop` reaps the child.

use std::{path::Path, process::Stdio, time::Duration};

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::timeout,
};

use crate::config::AgentConfig;

use super::HarnessSession;

/// How long a child gets to exit after its stdin closes before it is killed.
const CHILD_EXIT_GRACE: Duration = Duration::from_secs(2);
/// Upper bound for spawn, initialize, session creation and model selection.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
/// Upper bound for the best-effort `session/delete` during shutdown.
const DELETE_TIMEOUT: Duration = Duration::from_secs(2);

/// One persistent `opencode acp` process owned by exactly one agent.
pub struct OpencodeSession {
    agent_name: String,
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Lines<BufReader<ChildStdout>>,
    session_id: String,
    next_request_id: u64,
    context_tokens: Option<u64>,
    /// Set once a transport error proves this session can never recover.
    failure: Option<String>,
}

/// Assistant output collected while one prompt request is in flight.
#[derive(Default)]
struct Turn {
    /// Text chunks grouped by assistant message id, in arrival order.
    messages: Vec<(String, String)>,
    used: Option<u64>,
}

impl Turn {
    fn absorb(&mut self, update: &Value) {
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message_chunk") => {
                let Some(text) = update.pointer("/content/text").and_then(Value::as_str) else {
                    return;
                };
                let id = update
                    .get("messageId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                match self.messages.last_mut() {
                    Some((last, buffer)) if last == id => buffer.push_str(text),
                    _ => self.messages.push((id.to_string(), text.to_string())),
                }
            }
            Some("usage_update") => {
                if let Some(used) = update.get("used").and_then(Value::as_u64) {
                    self.used = Some(used);
                }
            }
            _ => {}
        }
    }

    fn reply(&self) -> Option<&str> {
        self.messages
            .iter()
            .rev()
            .map(|(_, text)| text.trim())
            .find(|text| !text.is_empty())
    }
}

impl OpencodeSession {
    pub async fn start(binary: &str, agent: &AgentConfig) -> Result<Self> {
        if agent.fast.is_some() {
            bail!(
                "OpenCode runtime does not support the OMP-specific 'fast' setting for agent '{}'",
                agent.name
            );
        }
        if agent
            .reasoning
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        {
            bail!(
                "OpenCode runtime does not support the 'reasoning' setting for agent '{}'; remove it or choose another runtime",
                agent.name
            );
        }
        let model = match agent
            .model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(model) if model.split_once('/').is_some_and(|(p, m)| !p.is_empty() && !m.is_empty()) => {
                Some(model)
            }
            Some(model) => bail!(
                "OpenCode model '{model}' for agent '{}' must be 'provider/model-id', for example 'opencode/big-pickle'",
                agent.name
            ),
            None => None,
        };
        let workspace = Path::new(&agent.workspace);
        if !workspace.is_dir() {
            bail!(
                "workspace '{}' for OpenCode agent '{}' is not a directory",
                workspace.display(),
                agent.name
            );
        }

        match timeout(STARTUP_TIMEOUT, Self::spawn_and_open(binary, agent, model)).await {
            Ok(result) => result,
            Err(_) => bail!(
                "OpenCode session for agent '{}' did not become ready within {}s",
                agent.name,
                STARTUP_TIMEOUT.as_secs()
            ),
        }
    }

    /// OpenCode permission config: everything allowed unless the persona's roles withhold editing or shell.
    fn permission(agent: &AgentConfig) -> Value {
        let Some(access) = agent.tool_access else { return json!("allow") };
        let mut rules = json!({"*": "allow"});
        if !access.write {
            rules["edit"] = json!("deny");
        }
        if !access.exec {
            rules["bash"] = json!("deny");
        }
        rules
    }

    async fn spawn_and_open(binary: &str, agent: &AgentConfig, model: Option<&str>) -> Result<Self> {
        let mut command = Command::new(binary);
        command
            .arg("acp")
            .current_dir(&agent.workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        let mut config = json!({"permission": Self::permission(agent)});
        if !agent.system_prompt.trim().is_empty() {
            config["agent"] = json!({"build": {"prompt": agent.system_prompt}});
        }
        command.env("OPENCODE_CONFIG_CONTENT", config.to_string());
        let mut child = command.spawn().with_context(|| {
            format!(
                "failed to start OpenCode session for agent '{}': failed to spawn '{binary}'; is it installed and on PATH?",
                agent.name
            )
        })?;
        let stdin = child.stdin.take().context("OpenCode ACP did not provide stdin")?;
        let stdout = child.stdout.take().context("OpenCode ACP did not provide stdout")?;
        let mut session = Self {
            agent_name: agent.name.clone(),
            child,
            stdin: Some(stdin),
            lines: BufReader::new(stdout).lines(),
            session_id: String::new(),
            next_request_id: 1,
            context_tokens: None,
            failure: None,
        };

        session
            .request(
                "initialize",
                json!({"protocolVersion": 1, "clientCapabilities": {}}),
                None,
            )
            .await?;
        let created = session
            .request(
                "session/new",
                json!({"cwd": agent.workspace, "mcpServers": []}),
                None,
            )
            .await?;
        session.session_id = created
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .with_context(|| {
                format!(
                    "OpenCode session/new for '{}' returned no sessionId",
                    session.agent_name
                )
            })?;
        if let Some(model) = model {
            let sid = session.session_id.clone();
            session
                .request(
                    "session/set_config_option",
                    json!({"sessionId": sid, "configId": "model", "value": model}),
                    None,
                )
                .await?;
        }
        Ok(session)
    }

    async fn write(&mut self, frame: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(frame).context("failed to encode OpenCode ACP frame")?;
        bytes.push(b'\n');
        let stdin = self.stdin.as_mut().context("OpenCode ACP stdin is closed")?;
        stdin
            .write_all(&bytes)
            .await
            .context("failed to write OpenCode ACP frame")?;
        stdin
            .flush()
            .await
            .context("failed to flush OpenCode ACP frame")
    }

    async fn read(&mut self) -> Result<Value> {
        let line = self
            .lines
            .next_line()
            .await
            .context("failed reading OpenCode ACP output")?
            .context("OpenCode ACP exited before completing the request")?;
        serde_json::from_str(&line)
            .with_context(|| format!("OpenCode ACP returned invalid JSON: {line}"))
    }

    /// Send one JSON-RPC request and read until its response. Notifications
    /// feed `turn`; agent-to-client requests get a fixed answer. Transport
    /// errors poison the session; RPC errors do not.
    async fn request(&mut self, method: &str, params: Value, turn: Option<&mut Turn>) -> Result<Value> {
        let id = self.next_request_id;
        self.next_request_id += 1;
        match self.exchange(id, method, params, turn).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(message)) => bail!(
                "OpenCode {method} failed for '{}': {message}",
                self.agent_name
            ),
            Err(error) => {
                let error = error.context(format!(
                    "OpenCode ACP {method} failed for '{}'",
                    self.agent_name
                ));
                self.failure = Some(format!("{error:#}"));
                Err(error)
            }
        }
    }

    /// Outer error: transport failure. Inner error: JSON-RPC error response.
    async fn exchange(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
        mut turn: Option<&mut Turn>,
    ) -> Result<std::result::Result<Value, String>> {
        self.write(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .await?;
        loop {
            let frame = self.read().await?;
            let frame_method = frame.get("method").and_then(Value::as_str);
            let frame_id = frame.get("id");
            match (frame_method, frame_id) {
                (Some("session/request_permission"), Some(request_id)) => {
                    let reply = approve_permission(&frame);
                    self.write(&json!({"jsonrpc": "2.0", "id": request_id, "result": reply}))
                        .await?;
                }
                (Some(other), Some(request_id)) => {
                    self.write(&json!({
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": {"code": -32601, "message": format!("Hivemind does not implement {other}")}
                    }))
                    .await?;
                }
                (Some("session/update"), None) => {
                    let ours = frame
                        .pointer("/params/sessionId")
                        .and_then(Value::as_str)
                        .is_some_and(|sid| sid == self.session_id);
                    if let (true, Some(turn), Some(update)) =
                        (ours, turn.as_deref_mut(), frame.pointer("/params/update"))
                    {
                        turn.absorb(update);
                    }
                }
                (None, Some(response_id)) if response_id.as_u64() == Some(id) => {
                    if let Some(error) = frame.get("error") {
                        let message = error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown ACP error");
                        return Ok(Err(message.to_string()));
                    }
                    return Ok(Ok(frame.get("result").cloned().unwrap_or(Value::Null)));
                }
                _ => {}
            }
        }
    }
}

/// Pick the allow option of a permission request (Hivemind runs unattended).
fn approve_permission(frame: &Value) -> Value {
    let option = frame
        .pointer("/params/options")
        .and_then(Value::as_array)
        .and_then(|options| {
            options.iter().find(|option| {
                option.get("kind").and_then(Value::as_str) == Some("allow_once")
            })
        })
        .and_then(|option| option.get("optionId").and_then(Value::as_str));
    match option {
        Some(option_id) => json!({"outcome": {"outcome": "selected", "optionId": option_id}}),
        None => json!({"outcome": {"outcome": "cancelled"}}),
    }
}

#[async_trait]
impl HarnessSession for OpencodeSession {
    async fn prompt(&mut self, input: &str) -> Result<String> {
        if let Some(failure) = &self.failure {
            bail!(
                "OpenCode session for '{}' failed earlier and cannot continue: {failure}",
                self.agent_name
            );
        }
        let mut turn = Turn::default();
        let params = json!({
            "sessionId": self.session_id,
            "prompt": [{"type": "text", "text": input}]
        });
        let result = self.request("session/prompt", params, Some(&mut turn)).await?;
        if turn.used.is_some() {
            self.context_tokens = turn.used;
        }
        match result.get("stopReason").and_then(Value::as_str) {
            Some("end_turn") => {}
            Some("cancelled") => bail!(
                "OpenCode turn for '{}' was cancelled before it completed",
                self.agent_name
            ),
            Some(reason) => bail!(
                "OpenCode turn for '{}' stopped with '{reason}'",
                self.agent_name
            ),
            None => bail!(
                "OpenCode prompt result for '{}' had no stopReason",
                self.agent_name
            ),
        }
        match turn.reply() {
            Some(text) => Ok(text.to_string()),
            None => bail!(
                "OpenCode completed without assistant text for '{}'",
                self.agent_name
            ),
        }
    }

    async fn context_tokens(&mut self) -> Result<Option<u64>> {
        Ok(self.context_tokens)
    }

    async fn shutdown(&mut self) -> Result<()> {
        if self.failure.is_none() && !self.session_id.is_empty() {
            let params = json!({"sessionId": self.session_id});
            // Best effort: a failing delete must not keep the child alive.
            let _ = timeout(DELETE_TIMEOUT, self.request("session/delete", params, None)).await;
        }
        drop(self.stdin.take());
        match timeout(CHILD_EXIT_GRACE, self.child.wait()).await {
            Ok(result) => {
                result.context("failed to wait for OpenCode ACP child")?;
            }
            Err(_) => {
                self.child
                    .kill()
                    .await
                    .context("failed to kill OpenCode ACP child")?;
                self.child
                    .wait()
                    .await
                    .context("failed to reap OpenCode ACP child")?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn turn_returns_last_assistant_message_and_ignores_thoughts() {
        let mut turn = Turn::default();
        for update in [
            json!({"sessionUpdate":"agent_thought_chunk","messageId":"m1:reasoning","content":{"text":"hmm"}}),
            json!({"sessionUpdate":"agent_message_chunk","messageId":"m1","content":{"text":"I'll do it."}}),
            json!({"sessionUpdate":"tool_call","toolCallId":"t"}),
            json!({"sessionUpdate":"agent_message_chunk","messageId":"m2","content":{"text":"Done"}}),
            json!({"sessionUpdate":"agent_message_chunk","messageId":"m2","content":{"text":" now. "}}),
            json!({"sessionUpdate":"usage_update","used":7248,"size":200000}),
        ] {
            turn.absorb(&update);
        }
        assert_eq!(turn.reply(), Some("Done now."));
        assert_eq!(turn.used, Some(7248));
        assert_eq!(Turn::default().reply(), None);
    }

    #[test]
    fn permission_requests_are_answered_with_allow_once() {
        let frame = json!({"params":{"options":[
            {"optionId":"always","kind":"allow_always"},
            {"optionId":"once","kind":"allow_once"},
            {"optionId":"reject","kind":"reject_once"}]}});
        assert_eq!(
            approve_permission(&frame),
            json!({"outcome":{"outcome":"selected","optionId":"once"}})
        );
        let only_reject = json!({"params":{"options":[{"optionId":"reject","kind":"reject_once"}]}});
        assert_eq!(
            approve_permission(&only_reject),
            json!({"outcome":{"outcome":"cancelled"}})
        );
    }
}
