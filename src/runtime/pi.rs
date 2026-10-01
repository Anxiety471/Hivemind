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

use super::{HarnessSession, ToolAccess};

const CHILD_EXIT_GRACE: Duration = Duration::from_secs(2);

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
            .with_context(|| {
                format!("failed to spawn Pi binary '{binary}'; is it installed and on PATH?")
            })?;
        let stdin = child.stdin.take().context("Pi RPC did not provide stdin")?;
        let stdout = child
            .stdout
            .take()
            .context("Pi RPC did not provide stdout")?;
        Ok(Self {
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
}

impl PiSession {
    pub async fn start(binary: &str, agent: &AgentConfig, access: ToolAccess) -> Result<Self> {
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

        let args = Self::rpc_args(agent, access);
        let transport = ChildTransport::spawn(binary, &args, &agent.workspace)
            .await
            .with_context(|| {
                format!("failed to start Pi RPC process for agent '{}'", agent.name)
            })?;
        Ok(Self {
            agent_name: agent.name.clone(),
            transport,
            failure: None,
        })
    }

    fn rpc_args(agent: &AgentConfig, access: ToolAccess) -> Vec<String> {
        let mut args = vec!["--mode".into(), "rpc".into(), "--no-session".into()];
        if let Some(tools) = access.pi_tools() {
            args.extend(["--tools".into(), tools.into()]);
        }
        args.push("--append-system-prompt".into());
        args.push(agent.system_prompt.clone());
        if let Some(model) = agent.model.as_deref().filter(|s| !s.trim().is_empty()) {
            args.extend(["--model".into(), model.into()]);
        }
        if let Some(reasoning) = agent.reasoning.as_deref().filter(|s| !s.trim().is_empty()) {
            args.extend(["--thinking".into(), reasoning.into()]);
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

    async fn recv(&mut self) -> Result<Value> {
        match self.transport.recv().await {
            Ok(frame) => Ok(frame),
            Err(error) => {
                let error = error.context(format!("Pi RPC failed for agent '{}'", self.agent_name));
                self.failure = Some(format!("{error:#}"));
                Err(error)
            }
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
    async fn prompt(&mut self, input: &str) -> Result<String> {
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

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
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
            role: None,
        }
    }

    #[test]
    fn rpc_args_apply_prompt_model_and_reasoning_without_fast_mapping() {
        assert_eq!(
            PiSession::rpc_args(&agent(), ToolAccess::Full),
            [
                "--mode",
                "rpc",
                "--no-session",
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
    fn read_only_access_pins_a_non_editing_tool_allowlist() {
        let args = PiSession::rpc_args(&agent(), ToolAccess::ReadOnly);
        let at = args.iter().position(|arg| arg == "--tools").unwrap();
        let tools: Vec<&str> = args[at + 1].split(',').collect();
        assert_eq!(tools, ["read", "grep", "find", "ls"]);
        assert!(!PiSession::rpc_args(&agent(), ToolAccess::Full).contains(&"--tools".to_owned()));
    }

    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct FixtureDir(PathBuf);
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
    impl Drop for FixtureDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

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
        let mut session = PiSession::start(&fixture.binary(), &cfg, ToolAccess::Full)
            .await
            .unwrap();
        assert_eq!(
            session.prompt("hello").await.unwrap(),
            format!("{} prompt hello", fixture.workspace())
        );
        assert_eq!(session.prompt("again").await.unwrap(), "second turn");
        assert_eq!(session.context_tokens().await.unwrap(), Some(1234));
        session.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn malformed_and_exited_processes_report_agent_context() {
        for (script, expected) in [
            ("printf 'not-json\\n'", "malformed JSON"),
            ("exit 7", "exited"),
        ] {
            let fixture = FixtureDir::new(script);
            let mut cfg = agent();
            cfg.workspace = fixture.workspace();
            let mut session = PiSession::start(&fixture.binary(), &cfg, ToolAccess::Full)
                .await
                .unwrap();
            let error = session.prompt("hello").await.unwrap_err();
            let message = format!("{error:#}");
            assert!(
                message.contains("PiAgent") && message.contains(expected),
                "{message}"
            );
        }
    }

    #[tokio::test]
    async fn missing_binary_and_fast_setting_fail_usefully() {
        let cfg = agent();
        let error = PiSession::start("hivemind-missing-pi-binary", &cfg, ToolAccess::Full)
            .await
            .err()
            .expect("missing binary must fail session creation");
        assert!(format!("{error:#}").contains("PiAgent"));
        let mut cfg = agent();
        cfg.fast = Some(false);
        let error = PiSession::start("unused", &cfg, ToolAccess::Full)
            .await
            .err()
            .expect("unsupported fast setting must fail session creation");
        assert!(error.to_string().contains("fast"));
    }
}
