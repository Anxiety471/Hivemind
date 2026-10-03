//! Shared Agent Client Protocol (ACP) session over a line-delimited JSON-RPC child.
//!
//! OpenCode (`opencode acp`), Codex (`codex-acp`), Claude Code (`claude-code-acp`),
//! and Cursor (`agent acp`) all speak the same prompt/update protocol.

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

const CHILD_EXIT_GRACE: Duration = Duration::from_secs(2);
pub(super) const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const DELETE_TIMEOUT: Duration = Duration::from_secs(2);

/// One config option applied immediately after `session/new`.
#[derive(Clone, Debug)]
pub struct ConfigOption {
    pub id: &'static str,
    pub value: String,
}

/// Auto-answer blocking Cursor ACP extension methods (Hivemind has no human in the loop).
pub fn cursor_extension_reply(method: &str, _frame: &Value) -> Value {
    match method {
        "cursor/ask_question" => json!({"outcome": {"outcome": "skipped"}}),
        "cursor/create_plan" => json!({"outcome": {"outcome": "accepted"}}),
        "cursor/update_todos" => json!({"outcome": {"outcome": "accepted", "todos": []}}),
        "cursor/task" => json!({"outcome": {"outcome": "completed"}}),
        "cursor/generate_image" => json!({
            "outcome": {"outcome": "rejected", "reason": "image generation is not available in Hivemind"}
        }),
        _ => json!({"outcome": {"outcome": "cancelled"}}),
    }
}

pub fn default_initialize_params() -> Value {
    json!({"protocolVersion": 1, "clientCapabilities": {}})
}

#[derive(Clone, Copy)]
pub enum PermissionPolicy {
    Adapter,
    CursorCli,
}

impl PermissionPolicy {
    fn kinds(self) -> &'static [&'static str] {
        match self {
            Self::Adapter => &["allow_once"],
            Self::CursorCli => &["allow-once", "allow_once"],
        }
    }
}

pub fn cursor_initialize_params() -> Value {
    json!({
        "protocolVersion": 1,
        "clientCapabilities": {
            "fs": {"readTextFile": false, "writeTextFile": false},
            "terminal": false
        },
        "clientInfo": {"name": "hivemind", "version": "0.1.0"}
    })
}

/// How to spawn an ACP child for one runtime.
pub struct ChildSpec<'a> {
    pub label: &'static str,
    pub binary: &'a str,
    pub args: &'a [&'a str],
    pub session_new: Value,
    pub config_options: Vec<ConfigOption>,
    pub extra_env: Vec<(String, String)>,
    pub env_remove: &'a [&'a str],
    pub initialize_params: Value,
    pub post_initialize: Vec<(&'static str, Value)>,
    /// When set, calls `session/set_mode` after `session/new`.
    pub session_mode: Option<&'static str>,
    pub permission_policy: PermissionPolicy,
    pub extension_reply: Option<fn(&str, &Value) -> Value>,
}

/// One persistent ACP process owned by exactly one agent.
pub struct AcpSession {
    runtime: &'static str,
    agent_name: String,
    child: Child,
    _group: crate::execution::ProcessGroup,
    stdin: Option<ChildStdin>,
    lines: Lines<BufReader<ChildStdout>>,
    session_id: String,
    next_request_id: u64,
    context_tokens: Option<u64>,
    failure: Option<String>,
    progress: Option<super::ProgressSink>,
    permission_policy: PermissionPolicy,
    extension_reply: Option<fn(&str, &Value) -> Value>,
}

#[derive(Default)]
struct Turn {
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

impl AcpSession {
    pub async fn start(
        agent: &AgentConfig,
        spec: ChildSpec<'_>,
        private_env: &[String],
    ) -> Result<Self> {
        let workspace = Path::new(&agent.workspace);
        if !workspace.is_dir() {
            bail!(
                "workspace '{}' for {} agent '{}' is not a directory",
                workspace.display(),
                spec.label,
                agent.name
            );
        }
        let label = spec.label;
        match timeout(STARTUP_TIMEOUT, Self::spawn_and_open(agent, spec, private_env)).await {
            Ok(result) => result,
            Err(_) => bail!(
                "{} session for agent '{}' did not become ready within {}s",
                label,
                agent.name,
                STARTUP_TIMEOUT.as_secs()
            ),
        }
    }

    async fn spawn_and_open(
        agent: &AgentConfig,
        spec: ChildSpec<'_>,
        private_env: &[String],
    ) -> Result<Self> {
        let mut command = Command::new(spec.binary);
        for name in private_env {
            command.env_remove(name);
        }
        #[cfg(unix)]
        command.process_group(0);
        command
            .args(spec.args)
            .current_dir(&agent.workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        for (name, value) in spec.extra_env {
            command.env(name, value);
        }
        for name in spec.env_remove {
            command.env_remove(name);
        }
        let mut child = command.spawn().with_context(|| {
            format!(
                "failed to start {} session for agent '{}': failed to spawn '{}'; is it installed and on PATH?",
                spec.label,
                agent.name,
                spec.binary
            )
        })?;
        let group = crate::execution::ProcessGroup(child.id());
        let stdin = child
            .stdin
            .take()
            .with_context(|| format!("{} ACP did not provide stdin", spec.label))?;
        let stdout = child
            .stdout
            .take()
            .with_context(|| format!("{} ACP did not provide stdout", spec.label))?;
        let mut session = Self {
            runtime: spec.label,
            agent_name: agent.name.clone(),
            _group: group,
            child,
            stdin: Some(stdin),
            lines: BufReader::new(stdout).lines(),
            session_id: String::new(),
            next_request_id: 1,
            context_tokens: None,
            failure: None,
            progress: None,
            permission_policy: spec.permission_policy,
            extension_reply: spec.extension_reply,
        };

        session
            .request("initialize", spec.initialize_params, None)
            .await?;
        for (method, params) in spec.post_initialize {
            session.request(method, params, None).await?;
        }
        let created = session
            .request("session/new", spec.session_new, None)
            .await?;
        session.session_id = created
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .with_context(|| {
                format!(
                    "{} session/new for '{}' returned no sessionId",
                    spec.label,
                    session.agent_name
                )
            })?;
        for option in spec.config_options {
            let sid = session.session_id.clone();
            session
                .request(
                    "session/set_config_option",
                    json!({
                        "sessionId": sid,
                        "configId": option.id,
                        "value": option.value
                    }),
                    None,
                )
                .await?;
        }
        if let Some(mode) = spec.session_mode {
            let sid = session.session_id.clone();
            let _ = session
                .request(
                    "session/set_mode",
                    json!({"sessionId": sid, "modeId": mode}),
                    None,
                )
                .await;
        }
        Ok(session)
    }

    async fn write(&mut self, frame: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(frame)
            .with_context(|| format!("failed to encode {} ACP frame", self.runtime))?;
        bytes.push(b'\n');
        let stdin = self
            .stdin
            .as_mut()
            .with_context(|| format!("{} ACP stdin is closed", self.runtime))?;
        stdin
            .write_all(&bytes)
            .await
            .with_context(|| format!("failed to write {} ACP frame", self.runtime))?;
        stdin
            .flush()
            .await
            .with_context(|| format!("failed to flush {} ACP frame", self.runtime))
    }

    async fn read(&mut self) -> Result<Value> {
        let line = self
            .lines
            .next_line()
            .await
            .with_context(|| format!("failed reading {} ACP output", self.runtime))?
            .with_context(|| format!("{} ACP exited before completing the request", self.runtime))?;
        serde_json::from_str(&line).with_context(|| {
            format!("{} ACP returned invalid JSON: {line}", self.runtime)
        })
    }

    async fn request(
        &mut self,
        method: &str,
        params: Value,
        turn: Option<&mut Turn>,
    ) -> Result<Value> {
        let id = self.next_request_id;
        self.next_request_id += 1;
        match self.exchange(id, method, params, turn).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(message)) => bail!(
                "{} {method} failed for '{}': {message}",
                self.runtime,
                self.agent_name
            ),
            Err(error) => {
                let error = error.context(format!(
                    "{} ACP {method} failed for '{}'",
                    self.runtime,
                    self.agent_name
                ));
                self.failure = Some(format!("{error:#}"));
                Err(error)
            }
        }
    }

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
                    let reply = approve_permission(&frame, self.permission_policy.kinds());
                    self.write(&json!({"jsonrpc": "2.0", "id": request_id, "result": reply}))
                        .await?;
                }
                (Some(other), Some(request_id)) => {
                    if let Some(reply) = self.extension_reply.map(|handler| handler(other, &frame)) {
                        self.write(&json!({"jsonrpc": "2.0", "id": request_id, "result": reply}))
                            .await?;
                    } else {
                        self.write(&json!({
                            "jsonrpc": "2.0",
                            "id": request_id,
                            "error": {"code": -32601, "message": format!("Hivemind does not implement {other}")}
                        }))
                        .await?;
                    }
                }
                (Some("session/update"), None) => {
                    let ours = frame
                        .pointer("/params/sessionId")
                        .and_then(Value::as_str)
                        .is_some_and(|sid| sid == self.session_id);
                    if let (true, Some(turn), Some(update)) =
                        (ours, turn.as_deref_mut(), frame.pointer("/params/update"))
                    {
                        if let Some(sink) = &self.progress {
                            sink.touch();
                            sink.acp(update);
                        }
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

pub(super) fn approve_permission(frame: &Value, kinds: &[&str]) -> Value {
    let options = frame.pointer("/params/options").and_then(Value::as_array);
    for kind in kinds {
        let option_id = options.and_then(|options| {
            options
                .iter()
                .find(|option| option.get("kind").and_then(Value::as_str) == Some(*kind))
                .and_then(|option| option.get("optionId").and_then(Value::as_str))
        });
        if let Some(option_id) = option_id {
            return json!({"outcome": {"outcome": "selected", "optionId": option_id}});
        }
    }
    json!({"outcome": {"outcome": "cancelled"}})
}

#[async_trait]
impl HarnessSession for AcpSession {
    fn set_progress(&mut self, sink: Option<super::ProgressSink>) {
        self.progress = sink;
    }

    async fn prompt(&mut self, input: &str) -> Result<String> {
        if let Some(failure) = &self.failure {
            bail!(
                "{} session for '{}' failed earlier and cannot continue: {failure}",
                self.runtime,
                self.agent_name
            );
        }
        let mut turn = Turn::default();
        let params = json!({
            "sessionId": self.session_id,
            "prompt": [{"type": "text", "text": input}]
        });
        let result = self
            .request("session/prompt", params, Some(&mut turn))
            .await?;
        if turn.used.is_some() {
            self.context_tokens = turn.used;
        }
        match result.get("stopReason").and_then(Value::as_str) {
            Some("end_turn") => {}
            Some("cancelled") => bail!(
                "{} turn for '{}' was cancelled before it completed",
                self.runtime,
                self.agent_name
            ),
            Some(reason) => bail!(
                "{} turn for '{}' stopped with '{reason}'",
                self.runtime,
                self.agent_name
            ),
            None => bail!(
                "{} prompt result for '{}' had no stopReason",
                self.runtime,
                self.agent_name
            ),
        }
        match turn.reply() {
            Some(text) => Ok(text.to_string()),
            None => bail!(
                "{} completed without assistant text for '{}'",
                self.runtime,
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
            let _ = timeout(DELETE_TIMEOUT, self.request("session/delete", params, None)).await;
        }
        drop(self.stdin.take());
        match timeout(CHILD_EXIT_GRACE, self.child.wait()).await {
            Ok(result) => {
                result.with_context(|| format!("failed to wait for {} ACP child", self.runtime))?;
            }
            Err(_) => {
                self.child
                    .kill()
                    .await
                    .with_context(|| format!("failed to kill {} ACP child", self.runtime))?;
                self.child
                    .wait()
                    .await
                    .with_context(|| format!("failed to reap {} ACP child", self.runtime))?;
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
            approve_permission(&frame, &["allow_once"]),
            json!({"outcome":{"outcome":"selected","optionId":"once"}})
        );
        let cursor_frame = json!({"params":{"options":[
            {"optionId":"allow-once","kind":"allow-once"},
            {"optionId":"reject-once","kind":"reject-once"}]}});
        assert_eq!(
            approve_permission(&cursor_frame, &["allow_once", "allow-once"]),
            json!({"outcome":{"outcome":"selected","optionId":"allow-once"}})
        );
    }
}
