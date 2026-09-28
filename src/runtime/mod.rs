mod manager;
mod omp;
mod pi;
use anyhow::{bail, Result};
use async_trait::async_trait;

use crate::config::{AgentConfig, RuntimeConfig};

pub use manager::AgentManager;

/// A runtime-agnostic live session bound to a single agent.
///
/// One session is created at startup and reused for every prompt in the
/// chat process. Sessions are driven sequentially by their owning worker,
/// so implementations never see two concurrent prompts.
#[async_trait]
pub trait HarnessSession: Send {
    /// Send one user turn through the live session and return the reply.
    async fn prompt(&mut self, input: &str) -> Result<String>;
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
        other => bail!("unsupported runtime '{other}' for agent '{}'", agent.name),
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
        }
    }

    #[tokio::test]
    async fn manager_dispatches_two_independent_pi_agents_and_one_omp_agent() {
        let pi = Fixture::new(
            "pi",
            r#"
while IFS= read -r request; do
  case "$request" in
    *'"type":"new_session"'*) printf '%s\n' '{"type":"response","command":"new_session","success":true}' ;;
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
  esac
done
"#,
        );
        let runtime = RuntimeConfig {
            omp_binary: omp.binary("omp"),
            pi_binary: pi.binary("pi"),
        };
        let agents = [
            agent("Pi A", "pi", &pi.workspace()),
            agent("OMP", "omp", &omp.workspace()),
            agent("Pi B", "pi", &pi.workspace()),
        ];
        let manager = AgentManager::start(&runtime, &agents).await.unwrap();
        let replies = manager.prompt_all("hello").await;
        assert_eq!(replies[0].0, "Pi A");
        assert_eq!(replies[1].0, "OMP");
        assert_eq!(replies[2].0, "Pi B");
        assert!(replies[0].1.as_ref().unwrap().starts_with("pi-"));
        assert_eq!(replies[1].1.as_ref().unwrap(), "omp fixture");
        assert!(replies[2].1.as_ref().unwrap().starts_with("pi-"));
        assert_ne!(
            replies[0].1.as_ref().unwrap(),
            replies[2].1.as_ref().unwrap()
        );
        manager.shutdown().await;
    }
}
