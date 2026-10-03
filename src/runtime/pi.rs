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

const CHILD_EXIT_GRACE: Duration = Duration::from_secs(2);

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
            .with_context(|| {
                format!("failed to spawn Pi binary '{binary}'; is it installed and on PATH?")
            })?;
        let group = crate::execution::ProcessGroup(child.id());
        let stdin = child.stdin.take().context("Pi RPC did not provide stdin")?;
        let stdout = child
            .stdout
            .take()
            .context("Pi RPC did not provide stdout")?;
        Ok(Self {
            _group: group,
            child,
            stdin: Some(stdin),
            lines: BufReader::new(stdout).lines(),
        })
    }

    async fn send(&mut self, frame: &Value) -> Result<()> {
        let stdin = self.stdin.as_mut().context("Pi RPC stdin is closed")?;
        let mut bytes = serde_json::to_vec(frame).context("failed to encode Pi RPC command")?;
        bytes.push(b'\n');
        if let Err(error) = stdin.write_all(&bytes).await {
            let process = self
                .child
                .try_wait()
                .ok()
                .flatten()
                .map(|status| format!(" (process exited with {status})"))
                .unwrap_or_default();
            return Err(error).with_context(|| format!("failed to write Pi RPC command{process}"));
        }
        stdin
            .flush()
            .await
            .context("failed to flush Pi RPC command")?;
        Ok(())
    }
    async fn recv(&mut self) -> Result<Value> {
        let line = self
            .lines
            .next_line()
            .await
            .context("failed reading Pi RPC output")?
            .context("Pi RPC process exited before completing the request")?;
        serde_json::from_str(&line)
            .with_context(|| format!("Pi RPC returned malformed JSON: {line}"))
    }

    async fn shutdown(&mut self) -> Result<()> {
        drop(self.stdin.take());
        match timeout(CHILD_EXIT_GRACE, self.child.wait()).await {
            Ok(result) => {
                result.context("failed to wait for Pi RPC process")?;
            }
            Err(_) => {
                self.child
                    .kill()
                    .await
                    .context("failed to kill Pi RPC process")?;
                self.child
                    .wait()
                    .await
                    .context("failed to reap Pi RPC process")?;
            }
        }
        Ok(())
    }
}

/// A no-session Pi RPC process whose in-process context persists across prompts until Hivemind stops it.
pub struct PiSession {
    agent_name: String,
    transport: ChildTransport,
    failure: Option<String>,
    progress: Option<super::ProgressSink>,
    usage: Option<crate::execution::Usage>,
    usage_missing: bool,
    steer: std::sync::Arc<SteerShared>,
    /// Texts forwarded as `steer` whose acknowledgement has not arrived yet.
    sent_steers: std::collections::VecDeque<String>,
}

impl PiSession {
    #[cfg(test)]
    pub async fn start(binary: &str, agent: &AgentConfig) -> Result<Self> {
        Self::start_filtered(binary, agent, &[]).await
    }
    pub async fn start_filtered(
        binary: &str,
        agent: &AgentConfig,
        private_env: &[String],
    ) -> Result<Self> {
        if agent.fast.is_some() {
            bail!(
                "Pi runtime does not support the OMP-specific 'fast' setting for agent '{}'",
                agent.name
            );
        }
        let workspace = Path::new(&agent.workspace);
        if !workspace.is_dir() {
            bail!(
                "workspace '{}' for Pi agent '{}' is not a directory",
                workspace.display(),
                agent.name
            );
        }

        let args = Self::rpc_args(agent);
        let transport = ChildTransport::spawn(binary, &args, &agent.workspace, private_env)
            .await
            .with_context(|| {
                format!("failed to start Pi RPC process for agent '{}'", agent.name)
            })?;
        Ok(Self {
            agent_name: agent.name.clone(),
            transport,
            failure: None,
            progress: None,
            usage: None,
            usage_missing: false,
            steer: SteerShared::new(),
            sent_steers: std::collections::VecDeque::new(),
        })
    }

    fn rpc_args(agent: &AgentConfig) -> Vec<String> {
        let mut args = vec!["--mode".into(), "rpc".into(), "--no-session".into()];
        // Isolation: none of the user's own Pi setup reaches a Hivemind agent —
        // no extensions (or the MCP servers they bring), skills, prompt
        // templates, themes, AGENTS.md/CLAUDE.md, or project-local `.pi` files.
        // Credentials and settings (`auth.json`, default model) still apply.
        args.extend(
            [
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-themes",
                "--no-context-files",
                "--no-approve",
            ]
            .map(String::from),
        );
        args.push("--append-system-prompt".into());
        args.push(agent.system_prompt.clone());
        if let Some(model) = agent.model.as_deref().filter(|s| !s.trim().is_empty()) {
            args.extend(["--model".into(), model.into()]);
        }
        if let Some(reasoning) = agent.reasoning.as_deref().filter(|s| !s.trim().is_empty()) {
            args.extend(["--thinking".into(), reasoning.into()]);
        }
        if let Some(access) = agent.tool_access {
            // Explicit allowlist: read-only built-ins plus only what the persona's permissions grant.
            let mut tools = vec!["read", "grep", "find", "ls"];
            if access.write {
                tools.extend(["edit", "write"]);
            }
            if access.exec {
                tools.push("bash");
            }
            args.extend(["--tools".into(), tools.join(",")]);
        }
        args
    }

    async fn send(&mut self, frame: &Value) -> Result<()> {
        if let Err(error) = self.transport.send(frame).await {
            let error = error.context(format!(
                "Pi RPC write failed for agent '{}'",
                self.agent_name
            ));
            self.failure = Some(format!("{error:#}"));
            return Err(error);
        }
        Ok(())
    }

    /// Next frame from Pi. While a prompt is in flight this also forwards
    /// steered messages as they arrive and swallows their acknowledgements;
    /// a refused steer waits for the next prompt.
    async fn recv(&mut self) -> Result<Value> {
        loop {
            for text in self.steer.drain() {
                self.send(&json!({"type":"steer", "message": text})).await?;
                self.sent_steers.push_back(text);
            }
            let received = tokio::select! {
                received = self.transport.recv() => received,
                () = self.steer.wait() => continue,
            };
            let frame = match received {
                Ok(frame) => frame,
                Err(error) => {
                    let error =
                        error.context(format!("Pi RPC failed for agent '{}'", self.agent_name));
                    self.failure = Some(format!("{error:#}"));
                    return Err(error);
                }
            };
            if frame.get("type").and_then(Value::as_str) == Some("response")
                && frame.get("command").and_then(Value::as_str) == Some("steer")
            {
                if let Some(text) = self.sent_steers.pop_front() {
                    if frame.get("success").and_then(Value::as_bool) != Some(true) {
                        self.steer.requeue(text);
                    }
                }
                continue;
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
            return Ok(frame);
        }
    }

    async fn await_command_response(&mut self, command: &str) -> Result<Value> {
        loop {
            let frame = self.recv().await?;
            if frame.get("type").and_then(Value::as_str) != Some("response")
                || frame.get("command").and_then(Value::as_str) != Some(command)
            {
                continue;
            }
            if frame.get("success").and_then(Value::as_bool) == Some(true) {
                return Ok(frame);
            }
            let message = frame
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown RPC error");
            bail!(
                "Pi RPC {command} failed for agent '{}': {message}",
                self.agent_name
            );
        }
    }
}

#[async_trait]
impl HarnessSession for PiSession {
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
        self.send(&json!({"type":"get_session_stats"})).await?;
        let frame = self.await_command_response("get_session_stats").await?;
        Ok(frame
            .pointer("/data/contextUsage/tokens")
            .and_then(Value::as_u64))
    }

    async fn shutdown(&mut self) -> Result<()> {
        self.transport.shutdown().await
    }
}

impl PiSession {
    async fn run_prompt(&mut self, input: &str) -> Result<String> {
        if let Some(failure) = &self.failure {
            bail!(
                "Pi session for agent '{}' failed earlier and cannot continue: {failure}",
                self.agent_name
            );
        }

        self.send(&json!({"type":"prompt", "message":input}))
            .await?;

        let mut response = String::new();
        loop {
            let frame = self.recv().await?;
            match frame.get("type").and_then(Value::as_str) {
                Some("message_end") => {
                    if frame
                        .get("message")
                        .and_then(|message| message.get("role"))
                        .and_then(Value::as_str)
                        == Some("assistant")
                    {
                        response.clear();
                        if let Some(content) = frame
                            .get("message")
                            .and_then(|message| message.get("content"))
                            .and_then(Value::as_array)
                        {
                            for item in content {
                                if item.get("type").and_then(Value::as_str) == Some("text") {
                                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                                        response.push_str(text);
                                    }
                                }
                            }
                        }
                    }
                }
                Some("agent_settled") => {
                    let text = response.trim();
                    if text.is_empty() {
                        bail!(
                            "Pi completed without assistant text for agent '{}'",
                            self.agent_name
                        );
                    }
                    return Ok(text.to_owned());
                }
                Some("response")
                    if frame.get("command").and_then(Value::as_str) == Some("prompt")
                        && frame.get("success").and_then(Value::as_bool) == Some(false) =>
                {
                    let message = frame
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown RPC error");
                    bail!(
                        "Pi RPC prompt failed for agent '{}': {message}",
                        self.agent_name
                    );
                }
                _ => {}
            }
        }
    }
}

// Every test that builds a fixture below needs a POSIX shell script with an
// exec bit, so those are individually gated with `#[cfg(unix)]`; the `rpc_args`
// tests are portable and run everywhere.
#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    fn agent() -> AgentConfig {
        AgentConfig {
            name: "PiAgent".into(),
            runtime: "pi".into(),
            system_prompt: "Be useful.".into(),
            workspace: ".".into(),
            model: Some("provider/model".into()),
            reasoning: Some("high".into()),
            fast: None,
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
    fn rpc_args_apply_prompt_model_and_reasoning_without_fast_mapping() {
        assert_eq!(
            PiSession::rpc_args(&agent()),
            [
                "--mode",
                "rpc",
                "--no-session",
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-themes",
                "--no-context-files",
                "--no-approve",
                "--append-system-prompt",
                "Be useful.",
                "--model",
                "provider/model",
                "--thinking",
                "high",
            ]
        );
    }

    #[test]
    fn read_only_persona_gets_a_tool_allowlist_without_edit_or_shell() {
        let mut agent = agent();
        agent.tool_access = Some(crate::config::ToolAccess {
            write: false,
            exec: false,
        });
        let args = PiSession::rpc_args(&agent);
        let tools = &args[args.iter().position(|a| a == "--tools").unwrap() + 1];
        assert_eq!(tools, "read,grep,find,ls");
        agent.tool_access = Some(crate::config::ToolAccess {
            write: true,
            exec: false,
        });
        let args = PiSession::rpc_args(&agent);
        assert_eq!(
            args[args.iter().position(|a| a == "--tools").unwrap() + 1],
            "read,grep,find,ls,edit,write"
        );
    }

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[cfg(unix)]
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    #[cfg(unix)]
    struct FixtureDir(PathBuf);
    #[cfg(unix)]
    impl FixtureDir {
        fn new(script: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "hivemind-pi-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            let binary = path.join("pi-fixture");
            fs::write(
                &binary,
                format!(
                    "#!/bin/sh\nif [ \"${{HIVEMIND_FIXTURE_CHILD:-}}\" != 1 ]; then export HIVEMIND_FIXTURE_CHILD=1; exec /bin/sh -c \"$(cat $0)\"; fi\n{script}\n"
                ),
            )
            .unwrap();
            fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
            Self(path)
        }
        fn binary(&self) -> String {
            self.0.join("pi-fixture").to_string_lossy().into_owned()
        }
        fn workspace(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }
    #[cfg(unix)]
    impl Drop for FixtureDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn subprocess_rpc_keeps_context_across_prompts_and_reports_context_tokens() {
        let fixture = FixtureDir::new(
            r#"
prompt_count=0
while IFS= read -r request; do
  case "$request" in
    *'"type":"new_session"'*) exit 41 ;;
    *'"type":"get_session_stats"'*)
      printf '%s\n' '{"type":"response","command":"get_session_stats","success":true,"data":{"contextUsage":{"tokens":1234,"contextWindow":200000,"percent":0.6}}}' ;;
    *'"message":"hello"'*)
      prompt_count=$((prompt_count + 1))
      printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"intermediate"}]}}'
      printf '%s\n' '{"type":"message_end","message":{"role":"tool","content":[{"type":"text","text":"tool output"}]}}'
      printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"%s"},{"type":"text","text":" prompt hello"}]}}\n' "$PWD"
      printf '%s\n' '{"type":"agent_settled"}' ;;
    *'"type":"prompt"'*)
      prompt_count=$((prompt_count + 1))
      printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"second turn"}]}}' '{"type":"agent_settled"}' ;;
  esac
done
[ "$prompt_count" -eq 2 ] || exit 42
"#,
        );
        let mut cfg = agent();
        cfg.workspace = fixture.workspace();
        let mut session = PiSession::start(&fixture.binary(), &cfg).await.unwrap();
        assert_eq!(
            session.prompt("hello").await.unwrap(),
            format!("{} prompt hello", fixture.workspace())
        );
        assert_eq!(session.prompt("again").await.unwrap(), "second turn");
        assert_eq!(session.context_tokens().await.unwrap(), Some(1234));
        session.shutdown().await.unwrap();
    }

    /// A message steered mid-prompt reaches the running process as `steer`
    /// and its acknowledgement is not mistaken for a prompt frame.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_steer_reaches_the_running_prompt() {
        let fixture = FixtureDir::new(
            r#"
while IFS= read -r request; do
  case "$request" in
    *'"type":"prompt"'*)
      IFS= read -r steer_request
      msg=${steer_request#*\"message\":\"}
      msg=${msg%%\"*}
      printf '%s\n' '{"type":"response","command":"steer","success":true}'
      printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"steered: %s"}]}}\n' "$msg"
      printf '%s\n' '{"type":"agent_settled"}' ;;
  esac
done
"#,
        );
        let mut cfg = agent();
        cfg.workspace = fixture.workspace();
        let mut session = PiSession::start(&fixture.binary(), &cfg).await.unwrap();
        let handle = session.steer_handle().unwrap();
        // `join!` polls the prompt first, so the steer lands while it is in flight.
        let (reply, steered) = tokio::join!(session.prompt("work"), async {
            handle.try_steer("use sqlite")
        });
        assert!(steered);
        assert_eq!(reply.unwrap(), "steered: use sqlite");
        session.shutdown().await.unwrap();
        drop(session);
        assert!(!handle.try_steer("gone"), "a dropped session takes nothing");
    }

    /// A steer the runtime refuses, or one sent between prompts, is prepended
    /// to the next prompt instead of being dropped.
    #[cfg(unix)]
    #[tokio::test]
    async fn refused_and_idle_steers_lead_the_next_prompt() {
        let fixture = FixtureDir::new(
            r#"
while IFS= read -r request; do
  case "$request" in
    *'decision changed'*'idle note'*'next'*)
      printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"saw both"}]}}' '{"type":"agent_settled"}' ;;
    *'"type":"prompt"'*)
      IFS= read -r steer_request
      printf '%s\n' '{"type":"response","command":"steer","success":false,"error":"not running"}'
      printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}' '{"type":"agent_settled"}' ;;
  esac
done
"#,
        );
        let mut cfg = agent();
        cfg.workspace = fixture.workspace();
        let mut session = PiSession::start(&fixture.binary(), &cfg).await.unwrap();
        let handle = session.steer_handle().unwrap();
        let (reply, _) = tokio::join!(session.prompt("work"), async {
            handle.try_steer("decision changed")
        });
        assert_eq!(reply.unwrap(), "done");
        assert!(handle.try_steer("idle note"));
        assert_eq!(session.prompt("next").await.unwrap(), "saw both");
        session.shutdown().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn malformed_and_exited_processes_report_agent_context() {
        for (script, expected) in [
            ("printf 'not-json\\n'", "malformed JSON"),
            ("exit 7", "exited"),
        ] {
            let fixture = FixtureDir::new(script);
            let mut cfg = agent();
            cfg.workspace = fixture.workspace();
            let mut session = PiSession::start(&fixture.binary(), &cfg).await.unwrap();
            let error = session.prompt("hello").await.unwrap_err();
            let message = format!("{error:#}");
            assert!(
                message.contains("PiAgent") && message.contains(expected),
                "{message}"
            );
            session.shutdown().await.unwrap();
        }
    }

    #[tokio::test]
    async fn missing_binary_and_fast_setting_fail_usefully() {
        let cfg = agent();
        let error = PiSession::start("hivemind-missing-pi-binary", &cfg)
            .await
            .err()
            .expect("missing binary must fail session creation");
        assert!(format!("{error:#}").contains("PiAgent"));
        let mut cfg = agent();
        cfg.fast = Some(false);
        let error = PiSession::start("unused", &cfg)
            .await
            .err()
            .expect("unsupported fast setting must fail session creation");
        assert!(error.to_string().contains("fast"));
    }
}
