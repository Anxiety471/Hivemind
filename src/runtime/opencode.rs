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
//! - Isolation: the user's own OpenCode setup (global `opencode.json(c)`, MCP
//!   servers, plugins, `AGENTS.md`, agents, commands) must not leak into a
//!   Hivemind agent. `OPENCODE_CONFIG_DIR` replaces the global config dir
//!   (verified in v2.0.18: `config: OPENCODE_CONFIG_DIR ?? $XDG_CONFIG_HOME/opencode`)
//!   with a Hivemind-owned one, and `OPENCODE_DISABLE_PROJECT_CONFIG=1` stops
//!   discovery of `opencode.json`, `.opencode/` and `AGENTS.md` walking up from
//!   the workspace. Credentials and sessions live in the data dir, which stays
//!   shared, so logged-in providers keep working. Verified quirk: with no
//!   plugin at all, v2.0.18 drops its built-in `opencode` provider (Zen, free
//!   models), so the dir holds one no-op plugin ([`KEEP_PROVIDERS_PLUGIN`]).
//! - Permissions: Hivemind has no human in the loop, so the child config sets
//!   `{"*": "allow", "question": "deny"}` (verified: reads outside the
//!   workspace then raise no request, while `question` is denied so unattended
//!   turns do not trigger interactive form elicitation and abort). This matches
//!   Pi/OMP, which run tools without approval. As a fallback, any
//!   `session/request_permission` that still arrives is answered with the
//!   `allow_once` or `allow_always` option.
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
    _group: crate::execution::ProcessGroup,
    stdin: Option<ChildStdin>,
    lines: Lines<BufReader<ChildStdout>>,
    session_id: String,
    next_request_id: u64,
    context_tokens: Option<u64>,
    /// Set once a transport error proves this session can never recover.
    failure: Option<String>,
    progress: Option<super::ProgressSink>,
}

/// Assistant output collected while one prompt request is in flight.
#[derive(Default)]
struct Turn {
    /// Text chunks grouped by assistant message id, in arrival order.
    messages: Vec<(String, String)>,
    used: Option<u64>,
    /// Interactive questions formatted as markdown text, if asked via the question tool.
    question: Option<String>,
    /// Last tool failure reported via tool_call_update, if any.
    last_tool_failure: Option<(String, String)>,
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
            Some("tool_call" | "tool_call_update") => {
                let title = update
                    .get("title")
                    .and_then(Value::as_str)
                    .or_else(|| update.get("toolName").and_then(Value::as_str))
                    .unwrap_or_default();
                if title == "question" {
                    if let Some(raw_input) = update.get("rawInput") {
                        if let Some(formatted) = format_questions(raw_input) {
                            self.question = Some(formatted);
                        }
                    }
                }
                if update.get("status").and_then(Value::as_str) == Some("failed") {
                    let text = update
                        .pointer("/content/0/content/text")
                        .and_then(Value::as_str)
                        .or_else(|| update.pointer("/content/0/text").and_then(Value::as_str))
                        .unwrap_or("tool call failed");
                    self.last_tool_failure = Some((title.to_string(), text.to_string()));
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

fn format_questions(raw_input: &Value) -> Option<String> {
    let questions = raw_input.get("questions").and_then(Value::as_array)?;
    if questions.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for q in questions {
        let question = q
            .get("question")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())?;
        let mut text = question.to_string();
        if let Some(options) = q.get("options").and_then(Value::as_array) {
            for opt in options {
                let Some(label) = opt
                    .get("label")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                else {
                    continue;
                };
                let desc = opt
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                match desc {
                    Some(d) => text.push_str(&format!("\n- **{label}**: {d}")),
                    None => text.push_str(&format!("\n- **{label}**")),
                }
            }
        }
        parts.push(text);
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

/// No-op plugin kept in Hivemind's OpenCode config dir; see the module docs.
pub(super) const KEEP_PROVIDERS_PLUGIN: &str = "// Written by Hivemind. OpenCode drops its built-in `opencode` provider when no plugin loads; this no-op keeps it.\nexport const Hivemind = async () => ({});\n";

impl OpencodeSession {
    pub async fn start_filtered(
        binary: &str,
        config_dir: &Path,
        agent: &AgentConfig,
        private_env: &[String],
    ) -> Result<Self> {
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

        match timeout(
            STARTUP_TIMEOUT,
            Self::spawn_and_open(binary, config_dir, agent, model, private_env),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => bail!(
                "OpenCode session for agent '{}' did not become ready within {}s",
                agent.name,
                STARTUP_TIMEOUT.as_secs()
            ),
        }
    }

    /// OpenCode permission config: everything allowed unless the persona's roles withhold editing or shell.
    /// Interactive questions are denied because Hivemind runs unattended (no human in the loop),
    /// which prevents OpenCode from attempting form elicitation and cancelling the turn.
    fn permission(agent: &AgentConfig) -> Value {
        let mut rules = json!({"*": "allow", "question": "deny"});
        if let Some(access) = agent.tool_access {
            if !access.write {
                rules["edit"] = json!("deny");
            }
            if !access.exec {
                rules["bash"] = json!("deny");
            }
        }
        if !agent.web {
            rules["webfetch"] = json!("deny");
            rules["websearch"] = json!("deny");
        }
        rules
    }

    async fn spawn_and_open(
        binary: &str,
        config_dir: &Path,
        agent: &AgentConfig,
        model: Option<&str>,
        private_env: &[String],
    ) -> Result<Self> {
        super::write_owned_file(
            &config_dir.join("plugins").join("hivemind.js"),
            KEEP_PROVIDERS_PLUGIN,
        )
        .context("preparing Hivemind's OpenCode config directory")?;
        let mut command = Command::new(binary);
        for name in private_env {
            command.env_remove(name);
        }
        #[cfg(unix)]
        command.process_group(0);
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
        command
            .env("OPENCODE_CONFIG_CONTENT", config.to_string())
            .env("OPENCODE_CONFIG_DIR", config_dir)
            .env("OPENCODE_DISABLE_PROJECT_CONFIG", "1")
            .env_remove("OPENCODE_CONFIG");
        let mut child = command.spawn().with_context(|| {
            format!(
                "failed to start OpenCode session for agent '{}': failed to spawn '{binary}'; is it installed and on PATH?",
                agent.name
            )
        })?;
        let group = crate::execution::ProcessGroup(child.id());
        let stdin = child
            .stdin
            .take()
            .context("OpenCode ACP did not provide stdin")?;
        let stdout = child
            .stdout
            .take()
            .context("OpenCode ACP did not provide stdout")?;
        let mut session = Self {
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
        let stdin = self
            .stdin
            .as_mut()
            .context("OpenCode ACP stdin is closed")?;
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

/// Pick the allow option of a permission request (Hivemind runs unattended).
fn approve_permission(frame: &Value) -> Value {
    let options = frame.pointer("/params/options").and_then(Value::as_array);
    let option = options
        .and_then(|opts| {
            opts.iter()
                .find(|option| option.get("kind").and_then(Value::as_str) == Some("allow_once"))
                .or_else(|| {
                    opts.iter().find(|option| {
                        matches!(
                            option.get("kind").and_then(Value::as_str),
                            Some("allow_always" | "allow")
                        )
                    })
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
    fn set_progress(&mut self, sink: Option<super::ProgressSink>) {
        self.progress = sink;
    }
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
        let result = self
            .request("session/prompt", params, Some(&mut turn))
            .await?;
        if turn.used.is_some() {
            self.context_tokens = turn.used;
        }
        if let Some(text) = turn.reply() {
            return Ok(text.to_string());
        }
        if let Some(question_text) = turn.question {
            return Ok(question_text);
        }

        let stop_reason = result.get("stopReason").and_then(Value::as_str);
        match stop_reason {
            Some("end_turn" | "max_tokens") => bail!(
                "OpenCode completed without assistant text for '{}'",
                self.agent_name
            ),
            Some("cancelled") => {
                let detail = turn
                    .last_tool_failure
                    .as_ref()
                    .map(|(tool, err)| format!(": tool '{tool}' failed: {err}"))
                    .unwrap_or_default();
                bail!(
                    "OpenCode turn for '{}' was cancelled before it completed{detail}",
                    self.agent_name
                );
            }
            Some("refusal") => bail!(
                "OpenCode turn for '{}' was refused by the model",
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
        let only_always =
            json!({"params":{"options":[{"optionId":"always","kind":"allow_always"}]}});
        assert_eq!(
            approve_permission(&only_always),
            json!({"outcome":{"outcome":"selected","optionId":"always"}})
        );
        let only_reject =
            json!({"params":{"options":[{"optionId":"reject","kind":"reject_once"}]}});
        assert_eq!(
            approve_permission(&only_reject),
            json!({"outcome":{"outcome":"cancelled"}})
        );
    }

    #[test]
    fn permissions_deny_interactive_question_and_respect_web_access() {
        let mut agent = crate::config::HivemindConfig::default_poc().agents[0].clone();
        assert_eq!(
            OpencodeSession::permission(&agent),
            json!({"*": "allow", "question": "deny"})
        );
        agent.web = false;
        assert_eq!(
            OpencodeSession::permission(&agent),
            json!({"*": "allow", "question": "deny", "webfetch": "deny", "websearch": "deny"})
        );
    }

    #[test]
    fn turn_absorbs_question_tool_call_and_formats_markdown() {
        let mut turn = Turn::default();
        turn.absorb(&json!({
            "sessionUpdate": "tool_call_update",
            "title": "question",
            "status": "in_progress",
            "rawInput": {
                "questions": [
                    {
                        "question": "What kind of issue would you like to create?",
                        "header": "Issue Type",
                        "options": [
                            {"label": "GitHub Issue", "description": "Create an issue in a GitHub repository"},
                            {"label": "OpenCode Bug Report", "description": "Report a bug with OpenCode itself"},
                            {"label": "Work with Existing Issue"}
                        ]
                    }
                ]
            }
        }));
        assert_eq!(
            turn.question.as_deref(),
            Some("What kind of issue would you like to create?\n- **GitHub Issue**: Create an issue in a GitHub repository\n- **OpenCode Bug Report**: Report a bug with OpenCode itself\n- **Work with Existing Issue**")
        );
    }

    #[test]
    fn turn_captures_tool_failure() {
        let mut turn = Turn::default();
        turn.absorb(&json!({
            "sessionUpdate": "tool_call_update",
            "title": "question",
            "status": "failed",
            "content": [{"type": "content", "content": {"type": "text", "text": "The user dismissed this question"}}]
        }));
        assert_eq!(
            turn.last_tool_failure,
            Some(("question".into(), "The user dismissed this question".into()))
        );
    }
}
