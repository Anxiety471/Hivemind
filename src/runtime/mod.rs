mod omp;
mod pi;
mod pool;
use anyhow::{bail, Result};
use async_trait::async_trait;

use crate::config::{AgentConfig, RuntimeConfig};

pub use pool::{
    InvokeReply, InvokeRequest, PromptDelta, PromptPhase, RuntimePool, SessionCursor, TurnView,
};

/// A runtime-agnostic live session bound to one agent instance. Hivemind's
/// room history remains canonical; the session is a disposable cache.
#[async_trait]
pub trait HarnessSession: Send {
    /// Send one user turn through the live session and return the reply.
    async fn prompt(&mut self, input: &str) -> Result<String>;
    /// Runtime-reported context size of the live session, if the runtime knows it.
    async fn context_tokens(&mut self) -> Result<Option<u64>>;
    /// Release the underlying runtime (close/kill an OMP child, etc.).
    async fn shutdown(&mut self) -> Result<()>;
}

/// Create the live session for `agent`, dispatching on `agent.runtime`.
///
/// Every error names the agent that failed to start.
pub async fn create_session(
    runtime_config: &RuntimeConfig,
    agent: &AgentConfig,
) -> Result<Box<dyn HarnessSession>> {
    match agent.runtime.as_str() {
        "omp" => Ok(Box::new(
            omp::OmpSession::start(&runtime_config.omp_binary, agent).await?,
        )),
        "pi" => Ok(Box::new(
            pi::PiSession::start(&runtime_config.pi_binary, agent).await?,
        )),
        other => bail!(
            "unsupported runtime '{other}' for agent '{}'; supported runtimes are pi and omp, so change this agent's runtime",
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
            role: None,
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
}
