mod telemetry;
pub use telemetry::ProgressSink;
mod omp;
mod opencode;
mod pi;
mod pool;
use anyhow::{bail, Result};
use async_trait::async_trait;

use crate::config::{AgentConfig, RuntimeConfig};

pub use pool::{
    is_rotation, InvokeReply, InvokeRequest, PromptDelta, PromptPhase, RuntimePool, SessionCursor,
    TurnView,
};

/// A runtime-agnostic live session bound to one agent instance. Hivemind's
/// room history remains canonical; the session is a disposable cache.
#[async_trait]
pub trait HarnessSession: Send {
    fn set_progress(&mut self, _sink: Option<ProgressSink>) {}
    fn take_usage(&mut self) -> Option<crate::execution::Usage> {
        None
    }
    /// Send one user turn through the live session and return the reply.
    async fn prompt(&mut self, input: &str) -> Result<String>;
    /// Runtime-reported context size of the live session, if the runtime knows it.
    async fn context_tokens(&mut self) -> Result<Option<u64>>;
    /// Release the underlying runtime (close/kill an OMP child, etc.).
    async fn shutdown(&mut self) -> Result<()>;
}

/// Write `content` to `path` (creating parents) unless it already holds exactly that.
fn write_owned_file(path: &std::path::Path, content: &str) -> Result<()> {
    use anyhow::Context;
    if std::fs::read_to_string(path).is_ok_and(|text| text == content) {
        return Ok(());
    }
    path.parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(path, content))
        .with_context(|| format!("writing {}", path.display()))
}

/// Hivemind's harness directory; sessions refuse to start without it rather
/// than fall back to the user's own harness setup.
fn harness_dir<'a>(
    runtime_config: &'a RuntimeConfig,
    agent: &AgentConfig,
) -> Result<&'a std::path::Path> {
    runtime_config.harness_dir.as_deref().ok_or_else(|| {
        anyhow::anyhow!(
            "agent '{}' needs a Hivemind-owned harness directory (runtime.harness_dir)",
            agent.name
        )
    })
}

/// Create the live session for `agent`, dispatching on `agent.runtime`.
///
/// Every error names the agent that failed to start. No session sees the
/// user's own harness setup (extensions, skills, MCP servers, context files,
/// memory); see each adapter for how that runtime is isolated.
pub async fn create_session(
    runtime_config: &RuntimeConfig,
    agent: &AgentConfig,
) -> Result<Box<dyn HarnessSession>> {
    match agent.runtime.as_str() {
        "omp" => Ok(Box::new(
            omp::OmpSession::start_filtered(&runtime_config.omp_binary, harness_dir(runtime_config, agent)?, agent, &runtime_config.private_env).await?,
        )),
        "pi" => Ok(Box::new(
            pi::PiSession::start_filtered(&runtime_config.pi_binary, agent, &runtime_config.private_env).await?,
        )),
        "opencode" => Ok(Box::new(
            opencode::OpencodeSession::start_filtered(&runtime_config.opencode_binary, &harness_dir(runtime_config, agent)?.join("opencode"), agent, &runtime_config.private_env).await?,
        )),
        other => bail!(
            "unsupported runtime '{other}' for agent '{}'; supported runtimes are pi, omp and opencode, so change this agent's runtime",
            agent.name
        ),
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        events::EventBus,
        identity::AgentInstanceId,
        memory::{Caller, MemoryService, MemoryStore},
    };
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::PathBuf,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new(name: &str, script: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "hivemind-runtime-{name}-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).unwrap();
            let binary = dir.join(name);
            fs::write(
                &binary,
                format!(
                    "#!/bin/sh\nif [ \"${{HIVEMIND_FIXTURE_CHILD:-}}\" != 1 ]; then export HIVEMIND_FIXTURE_CHILD=1; exec /bin/sh -c \"$(cat $0)\"; fi\n{script}\n"
                ),
            )
            .unwrap();
            fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
            Self(dir)
        }
        fn binary(&self, name: &str) -> String {
            self.0.join(name).to_string_lossy().into_owned()
        }
        fn workspace(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn agent(name: &str, runtime: &str, workspace: &str) -> AgentConfig {
        AgentConfig {
            name: name.into(),
            runtime: runtime.into(),
            system_prompt: format!("Agent {name}"),
            workspace: workspace.into(),
            model: None,
            reasoning: None,
            fast: None,
            fallback_models: Vec::new(),
            role: None,
            capabilities: Vec::new(),
            permissions: Vec::new(),
            roles: Vec::new(),
            tool_access: None,
        }
    }

    #[tokio::test]
    async fn create_session_dispatches_two_independent_pi_agents_and_one_omp_agent() {
        let pi = Fixture::new(
            "pi",
            r#"
while IFS= read -r request; do
  case "$request" in
    *'"type":"new_session"'*) printf '%s\n' '{"type":"response","command":"new_session","success":true}' ;;
    *'"type":"get_session_stats"'*) printf '%s\n' '{"type":"response","command":"get_session_stats","success":true,"data":{}}' ;;
    *'"type":"prompt"'*)
      printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"pi-%s"}]}}\n' "$$"
      printf '%s\n' '{"type":"agent_settled"}' ;;
  esac
done
"#,
        );
        let omp = Fixture::new(
            "omp",
            r#"
printf '%s\n' '{"type":"ready"}'
while IFS= read -r request; do
  case "$request" in
    *'"type":"prompt"'*) printf '%s\n' '{"type":"response","id":"hivemind_prompt","success":true,"data":{"agentInvoked":true}}' '{"type":"prompt_result","id":"hivemind_prompt","status":"completed","sessionSettled":true}' ;;
    *'"type":"get_last_assistant_text"'*) printf '%s\n' '{"type":"response","id":"hivemind_last_text","success":true,"data":{"text":"omp fixture"}}' ;;
    *'"type":"get_session_stats"'*) printf '%s\n' '{"type":"response","id":"hivemind_stats","command":"get_session_stats","success":true,"data":{}}' ;;
  esac
done
"#,
        );
        let runtime = RuntimeConfig {
            omp_binary: omp.binary("omp"),
            pi_binary: pi.binary("pi"),
            harness_dir: Some(omp.0.join("harness")),
            ..RuntimeConfig::default()
        };
        let configured = [
            agent("Pi A", "pi", &pi.workspace()),
            agent("OMP", "omp", &omp.workspace()),
            agent("Pi B", "pi", &pi.workspace()),
        ];
        let mut replies = Vec::new();
        for agent in &configured {
            let mut session = create_session(&runtime, agent).await.unwrap();
            replies.push(session.prompt("hello").await.unwrap());
            session.shutdown().await.unwrap();
        }
        assert_eq!(replies[1], "omp fixture");
        assert!(replies[0].starts_with("pi-") && replies[2].starts_with("pi-"));
        assert_ne!(replies[0], replies[2]);
    }
    #[tokio::test]
    async fn runtime_pool_keeps_slash_colliding_and_related_instances_separate() {
        let pi = Fixture::new(
            "pi",
            r#"
while IFS= read -r request; do
  case "$request" in
    *'"type":"new_session"'*) printf '%s\n' '{"type":"response","command":"new_session","success":true}' ;;
    *'"type":"get_session_stats"'*) printf '%s\n' '{"type":"response","command":"get_session_stats","success":true,"data":{}}' ;;
    *'"type":"prompt"'*)
      printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"pi-%s"}]}}\n' "$$"
      printf '%s\n' '{"type":"agent_settled"}' ;;
  esac
done
"#,
        );
        let runtime = RuntimeConfig {
            pi_binary: pi.binary("pi"),
            idle_timeout_secs: 0,
            ..RuntimeConfig::default()
        };
        let memory = Arc::new(MemoryService::new(MemoryStore::in_memory().unwrap()));
        let pool = RuntimePool::new(runtime, 24_000, memory, EventBus::new());
        let identities = [
            AgentInstanceId::new("a/b", "c"),
            AgentInstanceId::new("a", "b/c"),
            AgentInstanceId::new("another-room", "c"),
            AgentInstanceId::new("a/b", "other"),
        ];
        let agents = [
            agent("c", "pi", &pi.workspace()),
            agent("b/c", "pi", &pi.workspace()),
            agent("c", "pi", &pi.workspace()),
            agent("other", "pi", &pi.workspace()),
        ];
        let view = TurnView {
            turn_id: "turn".into(),
            speakers: Vec::new(),
            state_json: "{}".into(),
        };
        let mut replies = Vec::new();
        for (agent_instance_id, agent) in identities.iter().zip(&agents) {
            let caller = Caller::agent(
                agent_instance_id.room_id.clone(),
                "",
                agent_instance_id.clone(),
                agent_instance_id.persona_id.clone(),
                agent_instance_id.persona_id.clone(),
            );
            replies.push(
                pool.invoke(
                    &caller,
                    InvokeRequest {
                        agent_instance_id,
                        agent,
                        phase: PromptPhase::TurnStart,
                        full: "hello",
                        delta: None,
                        view: &view,
                    },
                )
                .await
                .unwrap()
                .text,
            );
        }
        assert_eq!(
            replies
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            identities.len()
        );
        pool.shutdown().await;
    }

    /// Fake `opencode acp`; `prompt_body` is the shell run for each `session/prompt`.
    fn opencode_script(prompt_body: &str, startup: &str) -> String {
        format!(
            r#"
{startup}
while IFS= read -r request; do
  id=$(printf '%s' "$request" | sed -n 's/^{{"id":\([0-9]*\),.*/\1/p')
  case "$request" in
    *'"method":"initialize"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{"protocolVersion":1}}}}\n' "$id" ;;
    *'"method":"session/new"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{"sessionId":"ses_fake"}}}}\n' "$id" ;;
    *'"method":"session/set_config_option"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{}}}}\n' "$id" ;;
    *'"method":"session/delete"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{}}}}\n' "$id" ;;
    *'"method":"session/prompt"'*)
{prompt_body}
      ;;
  esac
done
"#
        )
    }

    const OPENCODE_REPLY: &str = r#"      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_fake","update":{"sessionUpdate":"agent_thought_chunk","messageId":"m1:reasoning","content":{"type":"text","text":"thinking"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_fake","update":{"sessionUpdate":"agent_message_chunk","messageId":"m1","content":{"type":"text","text":"working on it"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_fake","update":{"sessionUpdate":"agent_message_chunk","messageId":"m2","content":{"type":"text","text":"opencode fixture"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_fake","update":{"sessionUpdate":"usage_update","used":4321,"size":200000}}}'
      printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn"}}\n' "$id""#;

    fn opencode_runtime(fixture: &Fixture) -> RuntimeConfig {
        RuntimeConfig {
            opencode_binary: fixture.binary("opencode"),
            harness_dir: Some(fixture.0.join("harness")),
            ..RuntimeConfig::default()
        }
    }

    #[tokio::test]
    async fn opencode_session_returns_assistant_text_and_reported_context() {
        // Startup records the isolation env the child was given (cwd = workspace).
        let startup = r#"printf '%s|%s|%s\n' "$OPENCODE_CONFIG_DIR" "$OPENCODE_DISABLE_PROJECT_CONFIG" "${OPENCODE_CONFIG-unset}" > env"#;
        let fixture = Fixture::new("opencode", &opencode_script(OPENCODE_REPLY, startup));
        let mut configured = agent("Open", "opencode", &fixture.workspace());
        configured.model = Some("opencode/big-pickle".into());
        let mut session = create_session(&opencode_runtime(&fixture), &configured)
            .await
            .unwrap();
        assert_eq!(session.context_tokens().await.unwrap(), None);
        assert_eq!(session.prompt("hello").await.unwrap(), "opencode fixture");
        assert_eq!(session.context_tokens().await.unwrap(), Some(4321));
        assert_eq!(session.prompt("again").await.unwrap(), "opencode fixture");
        session.shutdown().await.unwrap();
        // The user's global and project OpenCode config never reach a Hivemind agent.
        let config_dir = fixture.0.join("harness").join("opencode");
        assert_eq!(
            fs::read_to_string(fixture.0.join("env")).unwrap(),
            format!("{}|1|unset\n", config_dir.display())
        );
        // Without any plugin OpenCode drops its built-in provider, so Hivemind keeps one.
        let plugins: Vec<_> = fs::read_dir(config_dir.join("plugins"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(plugins, ["hivemind.js"]);
    }

    #[tokio::test]
    async fn create_session_dispatches_opencode_next_to_pi_and_omp() {
        let fixture = Fixture::new("opencode", &opencode_script(OPENCODE_REPLY, ""));
        let omp = Fixture::new(
            "omp",
            r#"
printf '%s\n' '{"type":"ready"}'
while IFS= read -r request; do
  case "$request" in
    *'"type":"prompt"'*) printf '%s\n' '{"type":"response","id":"hivemind_prompt","success":true,"data":{"agentInvoked":true}}' '{"type":"prompt_result","id":"hivemind_prompt","status":"completed","sessionSettled":true}' ;;
    *'"type":"get_last_assistant_text"'*) printf '%s\n' '{"type":"response","id":"hivemind_last_text","success":true,"data":{"text":"omp fixture"}}' ;;
  esac
done
"#,
        );
        let runtime = RuntimeConfig {
            omp_binary: omp.binary("omp"),
            ..opencode_runtime(&fixture)
        };
        let mut replies = Vec::new();
        for configured in [
            agent("OMP", "omp", &omp.workspace()),
            agent("Open", "opencode", &fixture.workspace()),
        ] {
            let mut session = create_session(&runtime, &configured).await.unwrap();
            replies.push(session.prompt("hello").await.unwrap());
            session.shutdown().await.unwrap();
        }
        assert_eq!(replies, ["omp fixture", "opencode fixture"]);
    }

    #[tokio::test]
    async fn opencode_start_failure_and_bad_settings_name_the_agent() {
        let fixture = Fixture::new("opencode", &opencode_script(OPENCODE_REPLY, ""));
        let mut runtime = opencode_runtime(&fixture);
        runtime.opencode_binary = fixture.binary("missing-opencode");
        let error = create_session(&runtime, &agent("Open", "opencode", &fixture.workspace()))
            .await
            .err()
            .unwrap();
        let error = format!("{error:#}");
        assert!(
            error.contains("Open") && error.contains("missing-opencode"),
            "{error}"
        );

        let runtime = opencode_runtime(&fixture);
        let mut fast = agent("Fast", "opencode", &fixture.workspace());
        fast.fast = Some(true);
        let error = create_session(&runtime, &fast).await.err().unwrap();
        assert!(error.to_string().contains("'fast'") && error.to_string().contains("Fast"));
        let mut reasoning = agent("Think", "opencode", &fixture.workspace());
        reasoning.reasoning = Some("high".into());
        let error = create_session(&runtime, &reasoning).await.err().unwrap();
        assert!(error.to_string().contains("'reasoning'"));
        let mut model = agent("Model", "opencode", &fixture.workspace());
        model.model = Some("no-provider".into());
        let error = create_session(&runtime, &model).await.err().unwrap();
        assert!(error.to_string().contains("provider/model-id"));
    }

    #[tokio::test]
    async fn opencode_crash_mid_prompt_poisons_the_session() {
        let fixture = Fixture::new("opencode", &opencode_script("      exit 3", ""));
        let mut session = create_session(
            &opencode_runtime(&fixture),
            &agent("Crash", "opencode", &fixture.workspace()),
        )
        .await
        .unwrap();
        let error = format!("{:#}", session.prompt("hello").await.unwrap_err());
        assert!(
            error.contains("Crash") && error.contains("exited"),
            "{error}"
        );
        let again = session.prompt("hello").await.unwrap_err().to_string();
        assert!(again.contains("failed earlier"), "{again}");
        session.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn opencode_cancelled_turn_is_an_error_not_a_reply() {
        let body = r#"      printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"cancelled"}}\n' "$id""#;
        let fixture = Fixture::new("opencode", &opencode_script(body, ""));
        let mut session = create_session(
            &opencode_runtime(&fixture),
            &agent("Deny", "opencode", &fixture.workspace()),
        )
        .await
        .unwrap();
        let error = session.prompt("hello").await.unwrap_err().to_string();
        assert!(
            error.contains("cancelled") && error.contains("Deny"),
            "{error}"
        );
        session.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn opencode_hanging_startup_is_killed_when_the_future_is_dropped() {
        let fixture = Fixture::new(
            "opencode",
            &opencode_script(OPENCODE_REPLY, "echo $$ > pid\nexec sleep 300"),
        );
        let runtime = opencode_runtime(&fixture);
        let configured = agent("Hang", "opencode", &fixture.workspace());
        let start = create_session(&runtime, &configured);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(500), start)
                .await
                .is_err()
        );
        let pid = fs::read_to_string(fixture.0.join("pid")).unwrap();
        let proc = format!("/proc/{}", pid.trim());
        for _ in 0..50 {
            if !std::path::Path::new(&proc).exists() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!("hung opencode child {pid} survived cancellation");
    }
}
