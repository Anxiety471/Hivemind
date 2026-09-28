use std::time::Duration;

use anyhow::{anyhow, Result};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinSet,
    time::timeout,
};

use super::{create_session, HarnessSession};
use crate::config::{AgentConfig, RuntimeConfig};

/// Room for prompts queued ahead of a busy worker before `send` applies
/// backpressure. Chat turns never queue this deep; tests enqueue a few.
const WORKER_QUEUE_CAPACITY: usize = 8;

/// How long the manager waits for workers to finish their own bounded
/// session shutdowns before aborting them (`kill_on_drop` then reaps the
/// child as the backstop).
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Second, shorter bounded wait after aborting stuck workers.
const ABORT_GRACE: Duration = Duration::from_secs(1);

enum WorkerCommand {
    Prompt {
        input: String,
        reply: oneshot::Sender<Result<String>>,
    },
}

struct Worker {
    name: String,
    tx: mpsc::Sender<WorkerCommand>,
}

impl Worker {
    async fn send_prompt(&self, input: &str) -> oneshot::Receiver<Result<String>> {
        let (reply_tx, reply_rx) = oneshot::channel();
        let command = WorkerCommand::Prompt {
            input: input.to_string(),
            reply: reply_tx,
        };

        if self.tx.send(command).await.is_err() {
            // The worker died; fail this prompt with the agent's name
            // instead of hanging the turn.
            let (dead_tx, dead_rx) = oneshot::channel();
            let _ = dead_tx.send(Err(anyhow!("agent '{}' is not running", self.name)));
            return dead_rx;
        }

        reply_rx
    }
}

/// One worker task per agent; each task owns its session and handles
/// prompts strictly sequentially, while different workers run concurrently.
async fn run_worker(
    name: String,
    mut session: Box<dyn HarnessSession>,
    mut rx: mpsc::Receiver<WorkerCommand>,
) {
    while let Some(WorkerCommand::Prompt { input, reply }) = rx.recv().await {
        let result = session.prompt(&input).await;
        let _ = reply.send(result);
    }

    // Every sender is gone: the manager shut down or dropped. Release the
    // runtime for this agent.
    if let Err(error) = session.shutdown().await {
        eprintln!("warning: failed to shut down session for '{name}': {error:#}");
    }
}

/// Owns one live session per configured agent for the whole chat process.
pub struct AgentManager {
    workers: Vec<Worker>,
    tasks: JoinSet<()>,
}

impl AgentManager {
    /// Eagerly start one session per configured agent so a startup failure
    /// reports which agent failed and why, before the first prompt.
    pub async fn start(runtime_config: &RuntimeConfig, agents: &[AgentConfig]) -> Result<Self> {
        let mut sessions = Vec::with_capacity(agents.len());

        for agent in agents {
            match create_session(runtime_config, agent).await {
                Ok(session) => sessions.push((agent.name.clone(), session)),
                Err(error) => {
                    // Never leave already-started children behind.
                    for (name, mut session) in sessions {
                        if let Err(shutdown_error) = session.shutdown().await {
                            eprintln!("warning: failed to shut down '{name}': {shutdown_error:#}");
                        }
                    }
                    return Err(error);
                }
            }
        }

        Ok(Self::from_sessions(sessions))
    }

    fn from_sessions(sessions: Vec<(String, Box<dyn HarnessSession>)>) -> Self {
        let mut workers = Vec::with_capacity(sessions.len());
        let mut tasks = JoinSet::new();

        for (name, session) in sessions {
            let (tx, rx) = mpsc::channel(WORKER_QUEUE_CAPACITY);
            tasks.spawn(run_worker(name.clone(), session, rx));
            workers.push(Worker { name, tx });
        }

        Self { workers, tasks }
    }

    /// Fan one user input out to every worker and collect replies in
    /// configuration order. All prompts are enqueued before any reply is
    /// awaited, so the workers process them concurrently.
    pub async fn prompt_all(&self, input: &str) -> Vec<(String, Result<String>)> {
        let mut pending = Vec::with_capacity(self.workers.len());

        for worker in &self.workers {
            let receiver = worker.send_prompt(input).await;
            pending.push((worker.name.clone(), receiver));
        }

        let mut replies = Vec::with_capacity(pending.len());

        for (name, receiver) in pending {
            let result = match receiver.await {
                Ok(result) => result,
                Err(_) => Err(anyhow!("agent '{name}' stopped before replying")),
            };
            replies.push((name, result));
        }

        replies
    }

    /// Shut down every session. Workers release their sessions as soon as
    /// their senders drop, so all agents shut down concurrently under one
    /// bounded wait; a stuck worker is aborted and `kill_on_drop` reaps its
    /// child.
    pub async fn shutdown(mut self) {
        self.workers.clear();
        let mut tasks = self.tasks;

        if timeout(SHUTDOWN_GRACE, drain(&mut tasks)).await.is_err() {
            eprintln!("warning: agent sessions did not stop in time; killing them");
            tasks.abort_all();
            let _ = timeout(ABORT_GRACE, drain(&mut tasks)).await;
        }
    }
}

async fn drain(tasks: &mut JoinSet<()>) {
    while let Some(joined) = tasks.join_next().await {
        if let Err(error) = joined {
            eprintln!("warning: agent worker task failed: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use anyhow::{bail, Context};
    use async_trait::async_trait;
    use parking_lot::Mutex;
    use tokio::sync::Barrier;

    use super::*;

    #[derive(Default)]
    struct FakeState {
        prompts: Mutex<Vec<String>>,
        shutdowns: AtomicUsize,
        failure: Mutex<Option<String>>,
        barrier: Option<Arc<Barrier>>,
    }

    struct FakeSession {
        state: Arc<FakeState>,
    }

    #[async_trait]
    impl HarnessSession for FakeSession {
        async fn prompt(&mut self, input: &str) -> Result<String> {
            self.state.prompts.lock().push(input.to_string());

            if let Some(barrier) = &self.state.barrier {
                tokio::time::timeout(Duration::from_secs(5), barrier.wait())
                    .await
                    .context("agents did not prompt concurrently")?;
            }

            if let Some(failure) = &*self.state.failure.lock() {
                bail!("{failure}");
            }

            Ok(format!("echo:{input}"))
        }

        async fn shutdown(&mut self) -> Result<()> {
            self.state.shutdowns.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn fake_state() -> Arc<FakeState> {
        Arc::new(FakeState::default())
    }

    fn manager_with(agents: &[(&str, Arc<FakeState>)]) -> AgentManager {
        let sessions = agents
            .iter()
            .map(|(name, state)| {
                let session = FakeSession {
                    state: state.clone(),
                };
                (
                    (*name).to_string(),
                    Box::new(session) as Box<dyn HarnessSession>,
                )
            })
            .collect();

        AgentManager::from_sessions(sessions)
    }

    #[tokio::test]
    async fn one_agents_prompts_are_processed_in_order() {
        let state = fake_state();
        let manager = manager_with(&[("Maomao", state.clone())]);

        // Enqueue three prompts before awaiting any reply; the worker must
        // feed them to its session strictly in arrival order.
        let mut receivers = Vec::new();
        for input in ["first", "second", "third"] {
            receivers.push(manager.workers[0].send_prompt(input).await);
        }

        let mut replies = Vec::new();
        for receiver in receivers {
            replies.push(receiver.await.unwrap().unwrap());
        }

        assert_eq!(replies, ["echo:first", "echo:second", "echo:third"]);
        assert_eq!(*state.prompts.lock(), ["first", "second", "third"]);

        manager.shutdown().await;
    }

    #[tokio::test]
    async fn two_agents_run_concurrently() {
        let barrier = Arc::new(Barrier::new(2));
        let maomao = Arc::new(FakeState {
            barrier: Some(barrier.clone()),
            ..FakeState::default()
        });
        let albedo = Arc::new(FakeState {
            barrier: Some(barrier.clone()),
            ..FakeState::default()
        });
        let manager = manager_with(&[("Maomao", maomao.clone()), ("Albedo", albedo.clone())]);

        // Both workers must be inside `prompt` at the same time or the
        // barrier never trips and the bounded wait fails the test.
        let replies = manager.prompt_all("hello").await;

        assert_eq!(replies[0].0, "Maomao");
        assert_eq!(replies[0].1.as_ref().unwrap(), "echo:hello");
        assert_eq!(replies[1].0, "Albedo");
        assert_eq!(replies[1].1.as_ref().unwrap(), "echo:hello");
        assert_eq!(*maomao.prompts.lock(), ["hello"]);
        assert_eq!(*albedo.prompts.lock(), ["hello"]);

        manager.shutdown().await;
    }

    #[tokio::test]
    async fn errors_are_attributed_to_the_failing_agent() {
        let maomao = Arc::new(FakeState {
            failure: Mutex::new(Some("simulated RPC failure".into())),
            ..FakeState::default()
        });
        let albedo = fake_state();
        let manager = manager_with(&[("Maomao", maomao.clone()), ("Albedo", albedo.clone())]);

        let replies = manager.prompt_all("hello").await;

        assert_eq!(replies.len(), 2);
        assert_eq!(replies[0].0, "Maomao");
        let error = replies[0].1.as_ref().unwrap_err();
        assert!(
            error.to_string().contains("simulated RPC failure"),
            "unexpected error: {error:#}"
        );

        assert_eq!(replies[1].0, "Albedo");
        assert_eq!(replies[1].1.as_ref().unwrap(), "echo:hello");
        assert_eq!(*albedo.prompts.lock(), ["hello"]);

        manager.shutdown().await;
    }

    #[tokio::test]
    async fn shutdown_stops_every_agent_session() {
        let maomao = fake_state();
        let albedo = fake_state();
        let manager = manager_with(&[("Maomao", maomao.clone()), ("Albedo", albedo.clone())]);

        manager.shutdown().await;

        assert_eq!(maomao.shutdowns.load(Ordering::SeqCst), 1);
        assert_eq!(albedo.shutdowns.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn start_reports_unknown_runtime_for_the_agent() {
        let agent = AgentConfig {
            name: "Ghost".into(),
            runtime: "mystery".into(),
            system_prompt: String::new(),
            workspace: ".".into(),
            model: None,
            reasoning: None,
            fast: None,
        };

        let error = AgentManager::start(&RuntimeConfig::default(), std::slice::from_ref(&agent))
            .await
            .err()
            .expect("unknown runtime must fail session creation");
        let message = error.to_string();

        assert!(message.contains("Ghost"), "unattributed error: {message}");
        assert!(message.contains("mystery"), "missing runtime: {message}");
    }
}
