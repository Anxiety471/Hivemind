mod omp;
mod pi;
mod pool;
use anyhow::{bail, Result};
use async_trait::async_trait;

use crate::config::{AgentConfig, RuntimeConfig};

pub use pool::{
    InvokeReply, InvokeRequest, PromptDelta, PromptPhase, RuntimePool, SessionCursor, TurnView,
};

/// Delivers messages into a live session's in-flight run (`steer`), shared
/// between the session (which sends them to the runtime) and the pool (which
/// accepts them from callers).
///
/// A message is accepted only while a prompt is in flight. Anything accepted
/// but not yet sent when the run ends is handed back through
/// [`HarnessSession::take_unsteered`], so a message is never silently lost.
pub(crate) struct SteerShared {
    state: std::sync::Mutex<SteerState>,
    wake: tokio::sync::Notify,
}

#[derive(Default)]
struct SteerState {
    busy: bool,
    pending: Vec<String>,
}

impl SteerShared {
    pub(crate) fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            state: std::sync::Mutex::new(SteerState::default()),
            wake: tokio::sync::Notify::new(),
        })
    }

    /// Session side: a prompt starts.
    pub(crate) fn begin(&self) {
        let mut state = self.state.lock().expect("steer state");
        state.busy = true;
        state.pending.clear();
    }

    /// Session side: take messages waiting to be sent to the runtime.
    pub(crate) fn drain(&self) -> Vec<String> {
        std::mem::take(&mut self.state.lock().expect("steer state").pending)
    }

    /// Session side: the prompt ended; returns what never reached the runtime.
    pub(crate) fn end(&self) -> Vec<String> {
        let mut state = self.state.lock().expect("steer state");
        state.busy = false;
        std::mem::take(&mut state.pending)
    }

    pub(crate) async fn wait(&self) {
        self.wake.notified().await;
    }
}

/// Caller side of [`SteerShared`]. Holds the session weakly, so a session that
/// was dropped (for example, cancelled mid-run) stops accepting messages.
#[derive(Clone)]
pub struct SteerHandle(std::sync::Weak<SteerShared>);

impl SteerHandle {
    pub(crate) fn new(shared: &std::sync::Arc<SteerShared>) -> Self {
        Self(std::sync::Arc::downgrade(shared))
    }

    /// Queue `text` for the in-flight run. `false` means no run is in flight
    /// (or the session is gone) and the caller must deliver it another way.
    pub fn try_steer(&self, text: &str) -> bool {
        let Some(shared) = self.0.upgrade() else {
            return false;
        };
        {
            let mut state = shared.state.lock().expect("steer state");
            if !state.busy {
                return false;
            }
            state.pending.push(text.to_owned());
        }
        shared.wake.notify_one();
        true
    }
}

/// What a live session may do to the workspace.
///
/// Chat sessions (main, solo, group, `ask`, `all`) are `ReadOnly`: the
/// runtime process is launched with a tool allowlist that has no editing,
/// shell, or sub-agent tools, so the restriction holds no matter what the
/// model is told or asks for. Only task-thread workers get `Full`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolAccess {
    ReadOnly,
    Full,
}

impl ToolAccess {
    /// Pi `--tools` allowlist; `None` leaves Pi's default tools in place.
    pub(crate) fn pi_tools(self) -> Option<&'static str> {
        match self {
            Self::ReadOnly => Some("read,grep,find,ls"),
            Self::Full => None,
        }
    }

    /// OMP `--tools` allowlist; `None` leaves OMP's default tools in place.
    pub(crate) fn omp_tools(self) -> Option<&'static str> {
        match self {
            Self::ReadOnly => Some("read,grep,glob"),
            Self::Full => None,
        }
    }
}

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
    /// Handle for steering the in-flight run, if the runtime supports it.
    fn steer_handle(&self) -> Option<SteerHandle> {
        None
    }
    /// Steer messages accepted during the last prompt that the runtime never
    /// received (or rejected); the caller must deliver them another way.
    fn take_unsteered(&mut self) -> Vec<String> {
        Vec::new()
    }
}

/// Create the live session for `agent`, dispatching on `agent.runtime`.
///
/// Every error names the agent that failed to start.
pub async fn create_session(
    runtime_config: &RuntimeConfig,
    agent: &AgentConfig,
    access: ToolAccess,
) -> Result<Box<dyn HarnessSession>> {
    match agent.runtime.as_str() {
        "omp" => Ok(Box::new(
            omp::OmpSession::start(&runtime_config.omp_binary, agent, access).await?,
        )),
        "pi" => Ok(Box::new(
            pi::PiSession::start(&runtime_config.pi_binary, agent, access).await?,
        )),
        other => bail!(
            "unsupported runtime '{other}' for agent '{}'; supported runtimes are pi and omp, so change this agent's runtime",
            agent.name
        ),
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
            let mut session = create_session(&runtime, agent, ToolAccess::Full)
                .await
                .unwrap();
            replies.push(session.prompt("hello").await.unwrap());
            session.shutdown().await.unwrap();
        }
        assert_eq!(replies[1], "omp fixture");
        assert!(replies[0].starts_with("pi-") && replies[2].starts_with("pi-"));
        assert_ne!(replies[0], replies[2]);
    }
}
