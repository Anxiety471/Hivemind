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
}

impl ChildTransport {
    async fn spawn(binary: &str, args: &[String], workspace: &str) -> Result<Self> {
        let mut child = Command::new(binary)
            .args(args)
            .current_dir(workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("failed to spawn '{binary}'; is it installed and on PATH?"))?;

        let stdin = child
            .stdin
            .take()
            .context("OMP RPC did not provide stdin")?;
        let stdout = child
            .stdout
            .take()
            .context("OMP RPC did not provide stdout")?;

        Ok(Self {
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

/// One persistent OMP RPC process owned by exactly one agent.
pub struct OmpSession {
    agent_name: String,
    transport: Box<dyn RpcTransport>,
    /// Set once a transport error proves this session can never recover.
    failure: Option<String>,
}

impl OmpSession {
    /// Validate the agent, spawn the OMP RPC child, and initialize the
    /// session (wait for `ready`, apply `fast` when explicitly configured).
    pub async fn start(binary: &str, agent: &AgentConfig) -> Result<Self> {
        let workspace = Path::new(&agent.workspace);

        if !workspace.exists() {
            bail!(
                "workspace '{}' for agent '{}' does not exist",
                workspace.display(),
                agent.name
            );
        }

        let args = Self::rpc_args(agent);
        let transport = ChildTransport::spawn(binary, &args, &agent.workspace)
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

        args
    }

    fn rpc_args(agent: &AgentConfig) -> Vec<String> {
        let mut args = vec![
            "--mode".to_string(),
            "rpc".to_string(),
            "--no-ui".to_string(),
            // Verified: `--no-session` only disables on-disk session
            // persistence; in-process conversational context is retained
            // (checked against OMP source and two prompts on one live RPC
            // process), so the flag stays.
            "--no-session".to_string(),
        ];
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

    /// Read one frame; a transport failure poisons the whole session.
    async fn recv_frame(&mut self) -> Result<Value> {
        let result = self.transport.recv().await;

        match result {
            Ok(frame) => Ok(frame),
            Err(error) => {
                let error = error.context(format!("OMP RPC read failed for '{}'", self.agent_name));
                self.failure = Some(format!("{error:#}"));
                Err(error)
            }
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

#[async_trait]
impl HarnessSession for OmpSession {
    async fn prompt(&mut self, input: &str) -> Result<String> {
        if let Some(failure) = &self.failure {
            bail!(
                "OMP session for '{}' failed earlier and cannot continue: {failure}",
                self.agent_name
            );
        }

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
            Some(text) => Ok(text.to_string()),
            None => bail!(
                "OMP RPC completed without assistant text for '{}'",
                self.agent_name
            ),
        }
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
            role: None,
        }
    }

    #[test]
    fn rpc_args_apply_system_prompt_model_and_reasoning() {
        let args = OmpSession::rpc_args(&agent(None));

        assert_eq!(
            args,
            vec![
                "--mode",
                "rpc",
                "--no-ui",
                "--no-session",
                "--append-system-prompt",
                "You are the Engineer.",
                "--model",
                "example-model",
                "--thinking",
                "high",
            ]
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
