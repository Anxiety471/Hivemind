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

use super::{HarnessSession, SteerHandle, SteerShared};

/// How long a child gets to exit after its stdin closes before it is killed.
const CHILD_EXIT_GRACE: Duration = Duration::from_secs(2);

/// Line-based JSON request/response transport over a live RPC child.
///
/// The session logic above this trait deals only in frames; the trait owns
/// child lifetime (spawn, stdin/stdout, shutdown), which makes the full
/// session flow testable against an in-memory fake.
#[async_trait]
trait RpcTransport: Send {
    async fn send(&mut self, frame: &Value) -> Result<()>;
    async fn recv(&mut self) -> Result<Value>;
    /// Close stdin, wait a short grace period, then kill as a fallback.
    async fn shutdown(&mut self) -> Result<()>;
}

/// Real transport: one OMP child's piped stdin/stdout.
struct ChildTransport {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Lines<BufReader<ChildStdout>>,
    _group: crate::execution::ProcessGroup,
}

impl ChildTransport {
    async fn spawn(
        binary: &str,
        args: &[String],
        workspace: &str,
        private_env: &[String],
    ) -> Result<Self> {
        let mut command = Command::new(binary);
        for name in private_env {
            command.env_remove(name);
        }
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .args(args)
            .current_dir(workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("failed to spawn '{binary}'; is it installed and on PATH?"))?;

        let group = crate::execution::ProcessGroup(child.id());
        let stdin = child
            .stdin
            .take()
            .context("OMP RPC did not provide stdin")?;
        let stdout = child
            .stdout
            .take()
            .context("OMP RPC did not provide stdout")?;

        Ok(Self {
            _group: group,
            child,
            stdin: Some(stdin),
            lines: BufReader::new(stdout).lines(),
        })
    }
}

#[async_trait]
impl RpcTransport for ChildTransport {
    async fn send(&mut self, frame: &Value) -> Result<()> {
        let mut payload = serde_json::to_vec(frame).context("failed to encode OMP RPC command")?;
        payload.push(b'\n');

        let stdin = self
            .stdin
            .as_mut()
            .context("OMP RPC stdin is already closed")?;

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

    async fn recv(&mut self) -> Result<Value> {
        let line = match self.lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => bail!("OMP RPC exited unexpectedly"),
            Err(error) => return Err(error).context("failed reading OMP RPC output"),
        };

        serde_json::from_str(&line)
            .with_context(|| format!("OMP RPC returned invalid JSON: {line}"))
    }

    async fn shutdown(&mut self) -> Result<()> {
        drop(self.stdin.take());

        match timeout(CHILD_EXIT_GRACE, self.child.wait()).await {
            Ok(result) => {
                result.context("failed to wait for OMP RPC child")?;
            }
            Err(_) => {
                self.child
                    .kill()
                    .await
                    .context("failed to kill OMP RPC child")?;
                self.child
                    .wait()
                    .await
                    .context("failed to reap OMP RPC child")?;
            }
        }

        Ok(())
    }
}

/// Whether a message carries a Hivemind tool call, as a fence, tags, or header line.
fn has_tool_call(text: &str) -> bool {
    text.contains("hivemind-tool")
        || text.contains("hivemind_tool")
        || text.contains("<hivemind-tool>")
        || text.contains("<hivemind_tool>")
        || text.contains("[hivemind-tool]")
        || text.contains("[hivemind_tool]")
        || (text.contains("\"name\"")
            && (text.contains("\"memory.")
                || text.contains("\"workspace.")
                || text.contains("\"tasks.")
                || text.contains("\"messages.")
                || text.contains("\"agents.")
                || text.contains("\"groups.")
                || text.contains("\"artifacts.")
                || text.contains("\"context.")))
}

/// Settings overlay (`--config`, above global and project config) that, with
/// `--no-extensions --no-skills --no-rules`, keeps the user's own OMP setup out
/// of a Hivemind agent. Every discovery source is disabled, so no context file
/// (`AGENTS.md`, `.omp/AGENTS.md`, `CLAUDE.md`, …), MCP server, plugin, command,
/// hook, or project `.omp/config.yml` loads; OMP memory, auto-learn and the
/// advisor are off because Hivemind owns memory. Global settings (model roles,
/// providers) and credentials in `agent.db` still apply. Verified against OMP
/// 18.4.8 with `get_state`: skills, `learn`/`manage_skill`, and both kinds of
/// `AGENTS.md` disappear from the system prompt; available models are unchanged.
const ISOLATION_OVERLAY: &str = "# Written by Hivemind: OMP sessions it starts ignore your own OMP setup.\n\
disabledProviders: [native, omp-plugins, claude, agent-plugins, codex, agents, claude-plugins, gemini, opencode, cursor, windsurf, cline, github, vscode, agents-md, claude-md, mcp-json, ssh-json]\n\
memory:\n  backend: \"off\"\n\
autolearn:\n  enabled: false\n\
advisor:\n  enabled: false\n";

/// Extra overlay for personas without web access: switches off OMP's web search and URL fetch tools.
const NO_WEB_OVERLAY: &str = "# Written by Hivemind: web tools are off for this persona.\n\
web_search:\n  enabled: false\n\
fetch:\n  enabled: false\n";
const NO_WEB_OVERLAY_FILE: &str = "omp-noweb.yml";

/// One persistent OMP RPC process owned by exactly one agent.
pub struct OmpSession {
    agent_name: String,
    transport: Box<dyn RpcTransport>,
    /// Set once a transport error proves this session can never recover.
    failure: Option<String>,
    progress: Option<super::ProgressSink>,
    usage: Option<crate::execution::Usage>,
    usage_missing: bool,
    /// Latest assistant message of the current prompt that held a Hivemind tool call.
    /// OMP can keep going after it (for example after the model calls OMP's own `todo`
    /// tool), and `get_last_assistant_text` would then return only the trailing message.
    tool_reply: Option<String>,
    steer: std::sync::Arc<SteerShared>,
    /// `steer` requests awaiting acknowledgement, by request id.
    sent_steers: std::collections::HashMap<String, String>,
    next_steer: u64,
}

impl OmpSession {
    /// Validate the agent, spawn the OMP RPC child, and initialize the
    /// session (wait for `ready`, apply `fast` when explicitly configured).
    #[cfg(test)]
    pub async fn start(binary: &str, agent: &AgentConfig) -> Result<Self> {
        Self::start_filtered(binary, &std::env::temp_dir(), agent, &[]).await
    }
    pub async fn start_filtered(
        binary: &str,
        harness_dir: &Path,
        agent: &AgentConfig,
        private_env: &[String],
    ) -> Result<Self> {
        let workspace = Path::new(&agent.workspace);

        if !workspace.exists() {
            bail!(
                "workspace '{}' for agent '{}' does not exist",
                workspace.display(),
                agent.name
            );
        }

        let overlay = harness_dir.join("omp.yml");
        super::write_owned_file(&overlay, ISOLATION_OVERLAY)
            .context("preparing Hivemind's OMP settings overlay")?;
        if !agent.web {
            super::write_owned_file(&overlay.with_file_name(NO_WEB_OVERLAY_FILE), NO_WEB_OVERLAY)
                .context("preparing Hivemind's OMP no-web overlay")?;
        }
        let args = Self::rpc_args(agent, &overlay);
        let transport = ChildTransport::spawn(binary, &args, &agent.workspace, private_env)
            .await
            .with_context(|| format!("failed to start OMP session for agent '{}'", agent.name))?;

        Self::start_with_transport(agent, transport).await
    }

    async fn start_with_transport<T>(agent: &AgentConfig, transport: T) -> Result<Self>
    where
        T: RpcTransport + 'static,
    {
        let mut session = Self {
            agent_name: agent.name.clone(),
            transport: Box::new(transport),
            failure: None,
            progress: None,
            usage: None,
            usage_missing: false,
            tool_reply: None,
            steer: SteerShared::new(),
            sent_steers: std::collections::HashMap::new(),
            next_steer: 0,
        };

        session.wait_for_ready().await?;

        // `fast` is applied exactly once, during startup, and only when it
        // was explicitly configured. Omitted `fast` never sends
        // `set_fast_mode`, leaving OMP's own default untouched.
        if let Some(fast) = agent.fast {
            session
                .send_frame(&json!({
                    "id": "hivemind_fast",
                    "type": "set_fast_mode",
                    "enabled": fast
                }))
                .await?;
            session
                .wait_for_response("hivemind_fast", "set_fast_mode")
                .await?;
        }

        Ok(session)
    }

    fn agent_args(agent: &AgentConfig) -> Vec<String> {
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
        if let Some(access) = agent.tool_access {
            // Explicit allowlist: read-only built-ins plus only what the persona's permissions grant.
            // Sub-agents, browser, and desktop control are excluded because they could bypass it.
            let mut tools = vec!["read", "grep", "glob", "lsp"];
            if agent.web {
                tools.push("web_search");
            }
            tools.push("todo");
            if access.write {
                tools.extend(["edit", "write", "notebook"]);
            }
            if access.exec {
                tools.extend(["bash", "python"]);
            }
            args.push("--tools".into());
            args.push(tools.join(","));
        }
        args
    }

    fn rpc_args(agent: &AgentConfig, overlay: &Path) -> Vec<String> {
        let mut args = vec![
            "--mode".to_string(),
            "rpc".to_string(),
            "--no-ui".to_string(),
            // Verified: `--no-session` only disables on-disk session
            // persistence; in-process conversational context is retained
            // (checked against OMP source and two prompts on one live RPC
            // process), so the flag stays.
            "--no-session".to_string(),
            "--no-extensions".to_string(),
            "--no-skills".to_string(),
            "--no-rules".to_string(),
            "--config".to_string(),
            overlay.display().to_string(),
        ];
        if !agent.web {
            args.extend([
                "--config".to_string(),
                overlay
                    .with_file_name(NO_WEB_OVERLAY_FILE)
                    .display()
                    .to_string(),
            ]);
        }
        args.extend(Self::agent_args(agent));
        args
    }

    /// Write one frame; a transport failure poisons the whole session.
    async fn send_frame(&mut self, frame: &Value) -> Result<()> {
        let result = self.transport.send(frame).await;

        match result {
            Ok(()) => Ok(()),
            Err(error) => {
                let error =
                    error.context(format!("OMP RPC write failed for '{}'", self.agent_name));
                self.failure = Some(format!("{error:#}"));
                Err(error)
            }
        }
    }

    /// Read one frame; a transport failure poisons the whole session. While a
    /// prompt is in flight this also forwards steered messages as they arrive
    /// and swallows their acknowledgements; a refused steer waits for the next prompt.
    async fn recv_frame(&mut self) -> Result<Value> {
        loop {
            for text in self.steer.drain() {
                self.next_steer += 1;
                let id = format!("hivemind_steer_{}", self.next_steer);
                self.send_frame(&json!({"id": id, "type": "steer", "message": text}))
                    .await?;
                self.sent_steers.insert(id, text);
            }
            let result = tokio::select! {
                result = self.transport.recv() => result,
                () = self.steer.wait() => continue,
            };
            let frame = match result {
                Ok(frame) => frame,
                Err(error) => {
                    let error =
                        error.context(format!("OMP RPC read failed for '{}'", self.agent_name));
                    self.failure = Some(format!("{error:#}"));
                    return Err(error);
                }
            };
            if frame.get("type").and_then(Value::as_str) == Some("response") {
                if let Some(text) = frame
                    .get("id")
                    .and_then(Value::as_str)
                    .and_then(|id| self.sent_steers.remove(id))
                {
                    if frame.get("success").and_then(Value::as_bool) != Some(true) {
                        self.steer.requeue(text);
                    }
                    continue;
                }
            }
            if let Some(sink) = &self.progress {
                sink.touch();
                sink.rpc(&frame);
            }
            if let Some(usage) = super::telemetry::rpc_usage(&frame) {
                self.usage.get_or_insert_with(Default::default).add(&usage);
            } else if frame["type"] == "message_end" && frame["message"]["role"] == "assistant" {
                self.usage_missing = true;
            }
            self.note_tool_reply(&frame);
            return Ok(frame);
        }
    }

    fn note_tool_reply(&mut self, frame: &Value) {
        let message = &frame["message"];
        if frame["type"] != "message_end" || message["role"] != "assistant" {
            return;
        }
        let text: String = message["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|part| part["type"] == "text")
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if has_tool_call(&text) {
            self.tool_reply = Some(text.trim().to_owned());
        }
    }

    async fn wait_for_ready(&mut self) -> Result<()> {
        loop {
            let frame = self.recv_frame().await?;

            if frame.get("type").and_then(Value::as_str) == Some("ready") {
                return Ok(());
            }
        }
    }

    async fn wait_for_response(&mut self, request_id: &str, command: &str) -> Result<Value> {
        loop {
            let frame = self.recv_frame().await?;

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

            bail!(
                "OMP RPC {command} failed for '{}': {error}",
                self.agent_name
            );
        }
    }

    async fn wait_for_prompt_result(&mut self, request_id: &str) -> Result<bool> {
        loop {
            let frame = self.recv_frame().await?;
            let frame_type = frame.get("type").and_then(Value::as_str);

            if frame_type == Some("response")
                && frame.get("id").and_then(Value::as_str) == Some(request_id)
            {
                if frame.get("success").and_then(Value::as_bool) != Some(true) {
                    let error = frame
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown RPC error");
                    bail!("OMP RPC prompt failed for '{}': {error}", self.agent_name);
                }

                if frame
                    .get("data")
                    .and_then(|data| data.get("agentInvoked"))
                    .and_then(Value::as_bool)
                    == Some(false)
                {
                    bail!(
                        "OMP RPC prompt for '{}' completed without invoking an agent",
                        self.agent_name
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
                    bail!("OMP provider failed for '{}': {error}", self.agent_name);
                }
                Some("aborted") => {
                    bail!("OMP prompt was aborted for '{}'", self.agent_name);
                }
                Some(status) => {
                    bail!(
                        "OMP returned unexpected prompt status '{status}' for '{}'",
                        self.agent_name
                    );
                }
                None => {
                    bail!("OMP prompt result for '{}' had no status", self.agent_name);
                }
            }
        }
    }

    async fn wait_for_session_settled(&mut self) -> Result<()> {
        loop {
            let frame = self.recv_frame().await?;

            if frame.get("type").and_then(Value::as_str) == Some("session_settled") {
                return Ok(());
            }
        }
    }
}

impl OmpSession {
    async fn run_prompt(&mut self, input: &str) -> Result<String> {
        if let Some(failure) = &self.failure {
            bail!(
                "OMP session for '{}' failed earlier and cannot continue: {failure}",
                self.agent_name
            );
        }

        self.tool_reply = None;
        self.send_frame(&json!({
            "id": "hivemind_prompt",
            "type": "prompt",
            "message": input
        }))
        .await?;

        let settled = self.wait_for_prompt_result("hivemind_prompt").await?;

        if !settled {
            self.wait_for_session_settled().await?;
        }

        self.send_frame(&json!({
            "id": "hivemind_last_text",
            "type": "get_last_assistant_text"
        }))
        .await?;

        let response = self
            .wait_for_response("hivemind_last_text", "get_last_assistant_text")
            .await?;

        let text = response
            .get("data")
            .and_then(|data| data.get("text"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty());

        match text {
            // The model asked for a Hivemind tool, then OMP carried on: the request is the reply.
            Some(text) if !has_tool_call(text) && self.tool_reply.is_some() => {
                Ok(self.tool_reply.take().unwrap_or_default())
            }
            Some(text) => Ok(text.to_string()),
            None => match self.tool_reply.take() {
                Some(reply) => Ok(reply),
                None => bail!(
                    "OMP RPC completed without assistant text for '{}'",
                    self.agent_name
                ),
            },
        }
    }
}

#[async_trait]
impl HarnessSession for OmpSession {
    fn set_progress(&mut self, sink: Option<super::ProgressSink>) {
        self.progress = sink;
        self.usage = None;
        self.usage_missing = false;
    }
    fn take_usage(&mut self) -> Option<crate::execution::Usage> {
        if self.usage_missing {
            self.usage = None;
        }
        self.usage.take()
    }
    async fn prompt(&mut self, input: &str) -> Result<String> {
        let input = self.steer.begin(input);
        let result = self.run_prompt(&input).await;
        self.steer.end();
        result
    }

    fn steer_handle(&self) -> Option<SteerHandle> {
        Some(SteerHandle::new(&self.steer))
    }

    async fn context_tokens(&mut self) -> Result<Option<u64>> {
        if self.failure.is_some() {
            return Ok(None);
        }
        self.send_frame(&json!({"id":"hivemind_stats","type":"get_session_stats"}))
            .await?;
        let frame = self
            .wait_for_response("hivemind_stats", "get_session_stats")
            .await?;
        Ok(frame
            .pointer("/data/contextUsage/tokens")
            .and_then(Value::as_u64))
    }

    async fn shutdown(&mut self) -> Result<()> {
        self.transport.shutdown().await
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
    };

    use parking_lot::Mutex;

    use super::*;

    fn agent(fast: Option<bool>) -> AgentConfig {
        AgentConfig {
            name: "Engineer".into(),
            runtime: "omp".into(),
            system_prompt: "You are the Engineer.".into(),
            workspace: ".".into(),
            model: Some("example-model".into()),
            reasoning: Some("high".into()),
            fast,
            fallback_models: Vec::new(),
            role: None,
            capabilities: Vec::new(),
            permissions: Vec::new(),
            roles: Vec::new(),
            tool_access: None,
            web: true,
        }
    }

    #[test]
    fn rpc_args_apply_system_prompt_model_and_reasoning() {
        let args = OmpSession::rpc_args(&agent(None), Path::new("/hive/harness/omp.yml"));

        assert_eq!(
            args,
            vec![
                "--mode",
                "rpc",
                "--no-ui",
                "--no-session",
                "--no-extensions",
                "--no-skills",
                "--no-rules",
                "--config",
                "/hive/harness/omp.yml",
                "--append-system-prompt",
                "You are the Engineer.",
                "--model",
                "example-model",
                "--thinking",
                "high",
            ]
        );
    }

    #[test]
    fn restricted_persona_gets_a_tool_allowlist_without_subagents_or_withheld_tools() {
        let mut agent = agent(None);
        agent.tool_access = Some(crate::config::ToolAccess {
            write: false,
            exec: false,
        });
        let overlay = Path::new("/hive/harness/omp.yml");
        let args = OmpSession::rpc_args(&agent, overlay);
        let tools = &args[args.iter().position(|a| a == "--tools").unwrap() + 1];
        assert_eq!(tools, "read,grep,glob,lsp,web_search,todo");
        agent.tool_access = Some(crate::config::ToolAccess {
            write: false,
            exec: true,
        });
        let args = OmpSession::rpc_args(&agent, overlay);
        assert!(
            args[args.iter().position(|a| a == "--tools").unwrap() + 1].ends_with("bash,python")
        );
    }

    #[test]
    fn web_off_drops_the_search_tool_and_adds_the_no_web_overlay() {
        let overlay = Path::new("/hive/harness/omp.yml");
        let mut agent = agent(None);
        agent.web = false;
        let args = OmpSession::rpc_args(&agent, overlay);
        assert!(args
            .windows(2)
            .any(|w| w == ["--config", "/hive/harness/omp-noweb.yml"]));
        assert!(!args.contains(&"--tools".to_string()));
        agent.tool_access = Some(crate::config::ToolAccess {
            write: false,
            exec: false,
        });
        let args = OmpSession::rpc_args(&agent, overlay);
        assert_eq!(
            args[args.iter().position(|a| a == "--tools").unwrap() + 1],
            "read,grep,glob,lsp,todo"
        );
    }

    #[derive(Default)]
    struct FakeScript {
        incoming: VecDeque<Result<Value, String>>,
        sent: Vec<Value>,
        shutdowns: AtomicUsize,
    }

    struct FakeTransport {
        script: Arc<Mutex<FakeScript>>,
    }

    #[async_trait]
    impl RpcTransport for FakeTransport {
        async fn send(&mut self, frame: &Value) -> Result<()> {
            self.script.lock().sent.push(frame.clone());
            Ok(())
        }

        async fn recv(&mut self) -> Result<Value> {
            match self.script.lock().incoming.pop_front() {
                Some(Ok(frame)) => Ok(frame),
                Some(Err(message)) => bail!("{message}"),
                None => bail!("fake transport script exhausted"),
            }
        }

        async fn shutdown(&mut self) -> Result<()> {
            self.script.lock().shutdowns.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn fake_transport() -> (Arc<Mutex<FakeScript>>, FakeTransport) {
        let script = Arc::new(Mutex::new(FakeScript::default()));
        let transport = FakeTransport {
            script: script.clone(),
        };
        (script, transport)
    }

    fn push_frame(script: &Arc<Mutex<FakeScript>>, frame: Value) {
        script.lock().incoming.push_back(Ok(frame));
    }

    fn push_error(script: &Arc<Mutex<FakeScript>>, message: &str) {
        script.lock().incoming.push_back(Err(message.to_string()));
    }

    fn push_ready(script: &Arc<Mutex<FakeScript>>) {
        push_frame(script, json!({ "type": "ready" }));
    }

    fn push_fast_ack(script: &Arc<Mutex<FakeScript>>) {
        push_frame(
            script,
            json!({ "type": "response", "id": "hivemind_fast", "success": true }),
        );
    }

    /// Script one full successful prompt turn for `reply`.
    fn push_prompt_turn(script: &Arc<Mutex<FakeScript>>, reply: &str, settled: bool) {
        push_frame(
            script,
            json!({
                "type": "response",
                "id": "hivemind_prompt",
                "success": true,
                "data": { "agentInvoked": true }
            }),
        );
        push_frame(
            script,
            json!({
                "type": "prompt_result",
                "id": "hivemind_prompt",
                "status": "completed",
                "sessionSettled": settled
            }),
        );
        if !settled {
            push_frame(script, json!({ "type": "session_settled" }));
        }
        push_frame(
            script,
            json!({
                "type": "response",
                "id": "hivemind_last_text",
                "success": true,
                "data": { "text": reply }
            }),
        );
    }

    fn sent_frames(script: &Arc<Mutex<FakeScript>>) -> Vec<Value> {
        script.lock().sent.clone()
    }

    /// Answers like OMP: the prompt is acknowledged at once, then runs until a
    /// `steer` arrives; the steer's text is what the run ends up saying.
    struct ReactiveTransport {
        frames: tokio::sync::mpsc::UnboundedSender<Value>,
        inbox: tokio::sync::mpsc::UnboundedReceiver<Value>,
        steered: Option<String>,
        reject_steers: bool,
        prompts: std::sync::Arc<parking_lot::Mutex<Vec<String>>>,
    }

    #[async_trait]
    impl RpcTransport for ReactiveTransport {
        async fn send(&mut self, frame: &Value) -> Result<()> {
            let id = frame["id"].clone();
            let reply = |value: Value| self.frames.send(value).unwrap();
            match frame["type"].as_str() {
                Some("prompt") => {
                    self.prompts
                        .lock()
                        .push(frame["message"].as_str().unwrap_or_default().to_owned());
                    reply(
                        json!({"type":"response","id":id,"success":true,"data":{"agentInvoked":true}}),
                    );
                    if self.prompts.lock().len() > 1 {
                        reply(
                            json!({"type":"prompt_result","id":"hivemind_prompt","status":"completed","sessionSettled":true}),
                        );
                    }
                }
                Some("steer") if self.reject_steers => reply(
                    json!({"type":"response","id":id,"success":false,"error":"nothing running"}),
                ),
                Some("steer") => {
                    self.steered = frame["message"].as_str().map(str::to_owned);
                    reply(json!({"type":"response","id":id,"success":true}));
                }
                Some("get_last_assistant_text") => {
                    let text = self.steered.clone().unwrap_or_else(|| "unsteered".into());
                    reply(
                        json!({"type":"response","id":id,"success":true,"data":{"text":format!("steered: {text}")}}),
                    );
                }
                _ => {}
            }
            // The first run finishes once it has been steered, or once a steer was refused.
            if frame["type"].as_str() == Some("steer") {
                reply(
                    json!({"type":"prompt_result","id":"hivemind_prompt","status":"completed","sessionSettled":true}),
                );
            }
            Ok(())
        }

        async fn recv(&mut self) -> Result<Value> {
            self.inbox
                .recv()
                .await
                .ok_or_else(|| anyhow::anyhow!("reactive transport closed"))
        }

        async fn shutdown(&mut self) -> Result<()> {
            Ok(())
        }
    }

    fn reactive(
        reject_steers: bool,
    ) -> (
        ReactiveTransport,
        std::sync::Arc<parking_lot::Mutex<Vec<String>>>,
    ) {
        let (frames, inbox) = tokio::sync::mpsc::unbounded_channel();
        frames.send(json!({"type":"ready"})).unwrap();
        let prompts = std::sync::Arc::default();
        (
            ReactiveTransport {
                frames,
                inbox,
                steered: None,
                reject_steers,
                prompts: std::sync::Arc::clone(&prompts),
            },
            prompts,
        )
    }

    #[tokio::test]
    async fn a_steer_is_forwarded_to_the_running_prompt_and_its_ack_swallowed() {
        let (transport, _) = reactive(false);
        let mut session = OmpSession::start_with_transport(&agent(None), transport)
            .await
            .unwrap();
        let handle = session.steer_handle().unwrap();
        // `join!` polls the prompt first, so the steer lands while it is in flight.
        let (reply, steered) = tokio::join!(session.prompt("work"), async {
            handle.try_steer("decision changed: use sqlite")
        });
        assert!(steered);
        assert_eq!(reply.unwrap(), "steered: decision changed: use sqlite");
    }

    #[tokio::test]
    async fn a_refused_omp_steer_leads_the_next_prompt() {
        let (transport, prompts) = reactive(true);
        let mut session = OmpSession::start_with_transport(&agent(None), transport)
            .await
            .unwrap();
        let handle = session.steer_handle().unwrap();
        let (reply, _) = tokio::join!(session.prompt("work"), async {
            handle.try_steer("new decision")
        });
        assert_eq!(reply.unwrap(), "steered: unsteered");
        session.prompt("next").await.unwrap();
        assert_eq!(prompts.lock().as_slice(), ["work", "new decision\n\nnext"]);
    }

    #[tokio::test]
    async fn fast_mode_is_applied_once_at_startup_when_configured() {
        let agent = agent(Some(true));
        let (script, transport) = fake_transport();
        push_ready(&script);
        push_fast_ack(&script);
        push_prompt_turn(&script, "first reply", true);
        push_prompt_turn(&script, "second reply", true);

        let mut session = OmpSession::start_with_transport(&agent, transport)
            .await
            .unwrap();

        assert_eq!(session.prompt("hello").await.unwrap(), "first reply");
        assert_eq!(session.prompt("again").await.unwrap(), "second reply");

        let sent = sent_frames(&script);
        let fast_frames: Vec<&Value> = sent
            .iter()
            .filter(|frame| frame["type"] == "set_fast_mode")
            .collect();
        assert_eq!(fast_frames.len(), 1);
        assert_eq!(fast_frames[0]["enabled"], json!(true));

        let prompts: Vec<&str> = sent
            .iter()
            .filter_map(|frame| frame["message"].as_str())
            .collect();
        assert_eq!(prompts, vec!["hello", "again"]);
    }

    #[tokio::test]
    async fn omitted_fast_leaves_omp_default_alone() {
        let agent = agent(None);
        let (script, transport) = fake_transport();
        push_ready(&script);
        push_prompt_turn(&script, "plain reply", true);

        let mut session = OmpSession::start_with_transport(&agent, transport)
            .await
            .unwrap();

        assert!(
            sent_frames(&script).is_empty(),
            "startup must send nothing when `fast` is omitted"
        );

        assert_eq!(session.prompt("hi").await.unwrap(), "plain reply");

        let sent = sent_frames(&script);
        assert!(sent.iter().all(|frame| frame["type"] != "set_fast_mode"));
    }

    #[tokio::test]
    async fn multiple_prompts_reuse_one_started_session() {
        let agent = agent(None);
        let (script, transport) = fake_transport();
        // A single `ready` frame: if the session re-initialized per prompt,
        // the script would be exhausted and these prompts would fail.
        push_ready(&script);
        push_prompt_turn(&script, "one", false);
        push_prompt_turn(&script, "two", true);
        push_prompt_turn(&script, "three", true);

        let mut session = OmpSession::start_with_transport(&agent, transport)
            .await
            .unwrap();

        assert_eq!(session.prompt("first").await.unwrap(), "one");
        assert_eq!(session.prompt("second").await.unwrap(), "two");
        assert_eq!(session.prompt("third").await.unwrap(), "three");

        let sent = sent_frames(&script);
        let prompt_count = sent
            .iter()
            .filter(|frame| frame["type"] == "prompt")
            .count();
        let fetch_count = sent
            .iter()
            .filter(|frame| frame["type"] == "get_last_assistant_text")
            .count();
        assert_eq!(prompt_count, 3);
        assert_eq!(fetch_count, 3);

        let unread = script.lock().incoming.len();
        assert_eq!(unread, 0, "the session must consume its scripted frames");
    }

    #[tokio::test]
    async fn tool_call_survives_omp_continuing_after_it() {
        let agent = agent(None);
        let (script, transport) = fake_transport();
        push_ready(&script);
        push_frame(
            &script,
            json!({ "type": "response", "id": "hivemind_prompt", "success": true, "data": { "agentInvoked": true } }),
        );
        push_frame(
            &script,
            json!({ "type": "message_end", "message": { "role": "assistant", "content": [
            { "type": "text", "text": "```hivemind-tool\n{\"name\":\"workspace.get\",\"args\":{}}\n```" }
        ] } }),
        );
        // OMP carries on (its own todo reminder), and its last message is only a status line.
        push_frame(
            &script,
            json!({ "type": "message_end", "message": { "role": "assistant", "content": [
            { "type": "text", "text": "Workspace lookup requested." }
        ] } }),
        );
        push_frame(
            &script,
            json!({ "type": "prompt_result", "id": "hivemind_prompt", "status": "completed", "sessionSettled": true }),
        );
        push_frame(
            &script,
            json!({ "type": "response", "id": "hivemind_last_text", "success": true, "data": { "text": "Workspace lookup requested." } }),
        );
        push_prompt_turn(&script, "plain answer", true);

        let mut session = OmpSession::start_with_transport(&agent, transport)
            .await
            .unwrap();
        let reply = session.prompt("where?").await.unwrap();
        assert!(
            reply.contains("workspace.get") && reply.starts_with("```hivemind-tool"),
            "{reply}"
        );
        // The next prompt starts clean: an earlier tool call never leaks into a plain answer.
        assert_eq!(session.prompt("again").await.unwrap(), "plain answer");
    }
    #[tokio::test]
    async fn unfenced_tool_call_survives_omp_continuing_after_it() {
        let agent = agent(None);
        let (script, transport) = fake_transport();
        push_ready(&script);
        push_frame(
            &script,
            json!({ "type": "response", "id": "hivemind_prompt", "success": true, "data": { "agentInvoked": true } }),
        );
        push_frame(
            &script,
            json!({ "type": "message_end", "message": { "role": "assistant", "content": [
            { "type": "text", "text": "hivemind-tool\n{\"name\":\"memory.search\",\"args\":{\"query\":\"test\"}}" }
        ] } }),
        );
        push_frame(
            &script,
            json!({ "type": "message_end", "message": { "role": "assistant", "content": [
            { "type": "text", "text": "Searching memory now." }
        ] } }),
        );
        push_frame(
            &script,
            json!({ "type": "prompt_result", "id": "hivemind_prompt", "status": "completed", "sessionSettled": true }),
        );
        push_frame(
            &script,
            json!({ "type": "response", "id": "hivemind_last_text", "success": true, "data": { "text": "Searching memory now." } }),
        );

        let mut session = OmpSession::start_with_transport(&agent, transport)
            .await
            .unwrap();
        let reply = session.prompt("search").await.unwrap();
        assert!(
            reply.contains("memory.search") && reply.starts_with("hivemind-tool"),
            "{reply}"
        );
    }

    #[tokio::test]
    async fn context_tokens_reads_runtime_usage_and_tolerates_absence() {
        let agent = agent(None);
        let (script, transport) = fake_transport();
        push_ready(&script);
        push_frame(
            &script,
            json!({
                "type": "response",
                "id": "hivemind_stats",
                "command": "get_session_stats",
                "success": true,
                "data": { "contextUsage": { "tokens": 77, "contextWindow": 1000, "percent": 7.7 } }
            }),
        );
        push_frame(
            &script,
            json!({
                "type": "response",
                "id": "hivemind_stats",
                "command": "get_session_stats",
                "success": true,
                "data": {}
            }),
        );

        let mut session = OmpSession::start_with_transport(&agent, transport)
            .await
            .unwrap();

        assert_eq!(session.context_tokens().await.unwrap(), Some(77));
        assert_eq!(session.context_tokens().await.unwrap(), None);
        assert_eq!(
            sent_frames(&script)[0],
            json!({"id":"hivemind_stats","type":"get_session_stats"})
        );
    }

    #[tokio::test]
    async fn child_death_blocks_the_session_and_names_the_agent() {
        let agent = agent(None);
        let (script, transport) = fake_transport();
        push_ready(&script);
        push_frame(
            &script,
            json!({
                "type": "response",
                "id": "hivemind_prompt",
                "success": true,
                "data": { "agentInvoked": true }
            }),
        );
        push_error(&script, "OMP RPC exited unexpectedly");

        let mut session = OmpSession::start_with_transport(&agent, transport)
            .await
            .unwrap();

        let error = session.prompt("hello").await.unwrap_err();
        let message = format!("{error:#}");
        assert!(
            message.contains("Engineer"),
            "unattributed error: {message}"
        );
        assert!(message.contains("exited"), "unclear error: {message}");

        let sent_after_death = sent_frames(&script).len();

        let error = session.prompt("try again").await.unwrap_err();
        let message = format!("{error:#}");
        assert!(
            message.contains("Engineer"),
            "unattributed error: {message}"
        );
        assert!(
            message.contains("failed earlier"),
            "expected a poisoned-session error: {message}"
        );

        assert_eq!(
            sent_frames(&script).len(),
            sent_after_death,
            "a failed session must not silently retry or respawn"
        );
    }

    #[tokio::test]
    async fn rpc_error_is_attributed_to_the_agent_and_recovers() {
        let agent = agent(None);
        let (script, transport) = fake_transport();
        push_ready(&script);
        push_frame(
            &script,
            json!({
                "type": "response",
                "id": "hivemind_prompt",
                "success": false,
                "error": "rate limited"
            }),
        );
        push_prompt_turn(&script, "recovered", true);

        let mut session = OmpSession::start_with_transport(&agent, transport)
            .await
            .unwrap();

        let error = session.prompt("hello").await.unwrap_err();
        let message = format!("{error:#}");
        assert!(
            message.contains("Engineer"),
            "unattributed error: {message}"
        );
        assert!(
            message.contains("rate limited"),
            "missing RPC error detail: {message}"
        );

        // A protocol-level error must not poison the still-live session.
        assert_eq!(session.prompt("try again").await.unwrap(), "recovered");
    }

    #[tokio::test]
    async fn shutdown_closes_the_child_transport() {
        let agent = agent(None);
        let (script, transport) = fake_transport();
        push_ready(&script);

        let mut session = OmpSession::start_with_transport(&agent, transport)
            .await
            .unwrap();

        assert_eq!(script.lock().shutdowns.load(Ordering::SeqCst), 0);

        session.shutdown().await.unwrap();

        assert_eq!(script.lock().shutdowns.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn missing_workspace_fails_before_spawn() {
        let mut agent = agent(None);
        agent.workspace = "/definitely/not/a/real/hivemind-workspace".into();

        let error = OmpSession::start("definitely-not-a-real-omp-binary", &agent)
            .await
            .err()
            .expect("missing workspace must fail before spawning");
        let message = format!("{error:#}");

        assert!(
            message.contains("workspace") && message.contains("Engineer"),
            "expected the workspace validation error, got: {message}"
        );
        assert!(
            !message.contains("spawn"),
            "the child must not be spawned before the workspace check: {message}"
        );
    }
}
