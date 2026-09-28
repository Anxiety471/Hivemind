use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use anyhow::{anyhow, Result};
use tokio::{
    sync::{mpsc, oneshot, Mutex, OwnedMutexGuard},
    task::JoinSet,
    time::timeout,
};

use super::{create_session, HarnessSession};
use crate::{
    config::{AgentConfig, RuntimeConfig},
    events::{DomainEventKind, EventBus},
};

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
    Prompt { input: String, reply: oneshot::Sender<Result<String>> },
    Shutdown,
}

enum WorkerStart {
    Ready(Box<dyn HarnessSession>),
    Lazy { runtime: Box<RuntimeConfig>, agent: Box<AgentConfig>, events: Option<EventBus> },
}

struct Worker {
    name: String,
    tx: mpsc::Sender<WorkerCommand>,
}

impl Worker {
    async fn send_prompt(&self, input: &str) -> oneshot::Receiver<Result<String>> {
        let (reply_tx, reply_rx) = oneshot::channel();
        let command = WorkerCommand::Prompt { input: input.to_string(), reply: reply_tx };
        if self.tx.send(command).await.is_err() {
            let (dead_tx, dead_rx) = oneshot::channel();
            let _ = dead_tx.send(Err(anyhow!("agent '{}' is not running", self.name)));
            return dead_rx;
        }
        reply_rx
    }
}

async fn run_worker(name: String, start: WorkerStart, mut rx: mpsc::Receiver<WorkerCommand>) {
    let (mut session, config, agent, events) = match start {
        WorkerStart::Ready(session) => (Some(session), None, None, None),
        WorkerStart::Lazy { runtime, agent, events } => (None, Some(runtime), Some(agent), events),
    };
    while let Some(command) = rx.recv().await {
        match command {
            WorkerCommand::Shutdown => break,
            WorkerCommand::Prompt { input, reply } => {
                if session.is_none() {
                    let runtime_config = config.as_ref().expect("lazy worker has runtime config");
                    let agent_config = agent.as_ref().expect("lazy worker has agent config");
                    match create_session(runtime_config, agent_config).await {
                        Ok(created) => {
                            if let Some(events) = &events {
                                events.publish(DomainEventKind::RuntimeStarted {
                                    agent_id: agent_config.name.clone(),
                                    instance_id: agent_config.name.clone(),
                                    runtime: agent_config.runtime.clone(),
                                });
                            }
                            session = Some(created);
                        }
                        Err(error) => {
                            if let Some(events) = &events {
                                events.publish(DomainEventKind::RuntimeFailed {
                                    agent_id: agent_config.name.clone(),
                                    instance_id: agent_config.name.clone(),
                                    runtime: agent_config.runtime.clone(),
                                    error_code: "runtime_start_failed".into(),
                                    message: "runtime session could not be started".into(),
                                });
                            }
                            let _ = reply.send(Err(error));
                            continue;
                        }
                    }
                }
                let result = session.as_mut().expect("session initialized").prompt(&input).await;
                let _ = reply.send(result);
            }
        }
    }
    if let Some(mut session) = session {
        if let Err(error) = session.shutdown().await {
            eprintln!("warning: failed to shut down session for '{name}': {error:#}");
        }
        if let (Some(events), Some(agent)) = (events, agent) {
            events.publish(DomainEventKind::RuntimeStopped {
                agent_id: agent.name.clone(),
                instance_id: agent.name,
                runtime: agent.runtime,
            });
        }
    }
}
/// Holds the turn's presentation slot until its caller has displayed all
/// replies.
pub struct PromptAllResult {
    pub replies: Vec<(String, Result<String>)>,
    _turn_guard: OwnedMutexGuard<()>,
}

impl std::ops::Deref for PromptAllResult {
    type Target = [(String, Result<String>)];

    fn deref(&self) -> &Self::Target {
        &self.replies
    }
}

/// Owns runtime sessions for the selected agents until shutdown.
pub struct AgentManager {
    workers: Vec<Worker>,
    tasks: Mutex<Option<JoinSet<()>>>,
    turn_lock: Arc<Mutex<()>>,
    shutting_down: AtomicBool,
}

impl AgentManager {
    /// Eagerly start one session per configured agent so a startup failure
    /// reports which agent failed and why, before the first prompt.
    pub async fn start(runtime_config: &RuntimeConfig, agents: &[&AgentConfig]) -> Result<Self> {
        let mut sessions = Vec::with_capacity(agents.len());

        for &agent in agents {
            match create_session(runtime_config, agent).await {
                Ok(session) => sessions.push((agent.name.clone(), session)),
                Err(error) => {
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
        Self::from_starts(sessions.into_iter().map(|(name, session)| {
            (name, WorkerStart::Ready(session))
        }).collect())
    }

    pub fn start_lazy(runtime: &RuntimeConfig, agents: &[&AgentConfig]) -> Self {
        Self::start_lazy_with_events(runtime, agents, None)
    }


    pub fn start_lazy_with_events(
        runtime: &RuntimeConfig,
        agents: &[&AgentConfig],
        events: Option<EventBus>,
    ) -> Self {
        let starts = agents.iter().map(|agent| (
            agent.name.clone(),
            WorkerStart::Lazy {
                runtime: Box::new(runtime.clone()),
                agent: Box::new((*agent).clone()),
                events: events.clone(),
            },
        )).collect();
        Self::from_starts(starts)
    }

    fn from_starts(starts: Vec<(String, WorkerStart)>) -> Self {
        let mut workers = Vec::with_capacity(starts.len());
        let mut tasks = JoinSet::new();
        for (name, start) in starts {
            let (tx, rx) = mpsc::channel(WORKER_QUEUE_CAPACITY);
            tasks.spawn(run_worker(name.clone(), start, rx));
            workers.push(Worker { name, tx });
        }
        Self {
            workers,
            tasks: Mutex::new(Some(tasks)),
            turn_lock: Arc::new(Mutex::new(())),
            shutting_down: AtomicBool::new(false),
        }
    }

















    /// Fan one user input out to every worker in manager order.
    pub async fn prompt_all(&self, input: &str) -> PromptAllResult {
        let turn_guard = self.turn_lock.clone().lock_owned().await;
        let mut pending = Vec::with_capacity(self.workers.len());
        for worker in &self.workers {
            pending.push((worker.name.clone(), worker.send_prompt(input).await));
        }
        let replies = Self::collect_replies(pending).await;
        PromptAllResult {
            replies,
            _turn_guard: turn_guard,
        }
    }


    pub async fn prompt_agent(&self, name: &str, input: &str) -> Result<String> {
        if self.shutting_down.load(Ordering::Acquire) {
            anyhow::bail!("agent manager is shutting down");
        }
        let worker = self
            .workers
            .iter()
            .find(|worker| worker.name == name)
            .ok_or_else(|| anyhow!("agent '{name}' is not managed by this runtime"))?;
        worker
            .send_prompt(input)
            .await
            .await
            .map_err(|_| anyhow!("agent '{name}' stopped before replying"))?
    }


    async fn collect_replies(
        pending: Vec<(String, oneshot::Receiver<Result<String>>)>,
    ) -> Vec<(String, Result<String>)> {
        let mut replies = Vec::with_capacity(pending.len());
        for (name, receiver) in pending {
            let result = receiver
                .await
                .unwrap_or_else(|_| Err(anyhow!("agent '{name}' stopped before replying")));
            replies.push((name, result));
        }
        replies
    }

    /// Stop all sessions, waiting for bounded worker shutdown before killing
    /// any task that remains stuck.
    pub async fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::AcqRel) {
            return;
        }
        for worker in &self.workers {
            let _ = worker.tx.send(WorkerCommand::Shutdown).await;
        }
        let Some(mut tasks) = self.tasks.lock().await.take() else {
            return;
        };

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
        delay: Option<Duration>,
        completion: Option<(Arc<Mutex<Vec<String>>>, String)>,
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

            if let Some(delay) = self.state.delay {
                tokio::time::sleep(delay).await;
            }
            if let Some(failure) = &*self.state.failure.lock() {
                bail!("{failure}");
            }

            if let Some((order, name)) = &self.state.completion {
                order.lock().push(name.clone());
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

        assert_eq!(replies.replies[0].0, "Maomao");
        assert_eq!(replies.replies[0].1.as_ref().unwrap(), "echo:hello");
        assert_eq!(replies.replies[1].0, "Albedo");
        assert_eq!(replies.replies[1].1.as_ref().unwrap(), "echo:hello");
        assert_eq!(*maomao.prompts.lock(), ["hello"]);
        assert_eq!(*albedo.prompts.lock(), ["hello"]);

        manager.shutdown().await;
    }

    #[tokio::test]
    async fn prompt_agent_calls_run_concurrently_across_workers() {
        let barrier = Arc::new(Barrier::new(2));
        let maomao = Arc::new(FakeState {
            barrier: Some(barrier.clone()),
            ..FakeState::default()
        });
        let albedo = Arc::new(FakeState {
            barrier: Some(barrier),
            ..FakeState::default()
        });
        let manager = manager_with(&[("Maomao", maomao.clone()), ("Albedo", albedo.clone())]);

        let (maomao_reply, albedo_reply) = tokio::join!(
            manager.prompt_agent("Maomao", "for Maomao"),
            manager.prompt_agent("Albedo", "for Albedo"),
        );

        assert_eq!(maomao_reply.unwrap(), "echo:for Maomao");
        assert_eq!(albedo_reply.unwrap(), "echo:for Albedo");
        assert_eq!(*maomao.prompts.lock(), ["for Maomao"]);
        assert_eq!(*albedo.prompts.lock(), ["for Albedo"]);
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

        assert_eq!(replies.replies.len(), 2);
        assert_eq!(replies.replies[0].0, "Maomao");
        let error = replies.replies[0].1.as_ref().unwrap_err();
        assert!(
            error.to_string().contains("simulated RPC failure"),
            "unexpected error: {error:#}"
        );

        assert_eq!(replies.replies[1].0, "Albedo");
        assert_eq!(replies.replies[1].1.as_ref().unwrap(), "echo:hello");
        assert_eq!(*albedo.prompts.lock(), ["hello"]);

        manager.shutdown().await;
    }
    #[tokio::test]
    async fn replies_keep_manager_order_when_workers_complete_out_of_order() {
        let completion_order = Arc::new(Mutex::new(Vec::new()));
        let slow = Arc::new(FakeState {
            delay: Some(Duration::from_millis(30)),
            completion: Some((completion_order.clone(), "Slow".into())),
            ..FakeState::default()
        });
        let fast = Arc::new(FakeState {
            completion: Some((completion_order.clone(), "Fast".into())),
            ..FakeState::default()
        });
        let manager = manager_with(&[("Slow", slow), ("Fast", fast)]);

        let replies = manager.prompt_all("hello").await;

        assert_eq!(*completion_order.lock(), ["Fast", "Slow"]);
        assert_eq!(
            replies
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            ["Slow", "Fast"]
        );
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn turn_guard_serializes_prompting_until_replies_are_presented() {
        let state = fake_state();
        let manager = Arc::new(manager_with(&[("Agent", state.clone())]));
        let first = manager.prompt_all("first").await;
        let next_manager = manager.clone();
        let next_turn = tokio::spawn(async move { next_manager.prompt_all("second").await });

        tokio::task::yield_now().await;
        assert_eq!(*state.prompts.lock(), ["first"]);

        drop(first);
        let second = next_turn.await.unwrap();
        assert_eq!(*state.prompts.lock(), ["first", "second"]);
        drop(second);

        Arc::try_unwrap(manager)
            .ok()
            .expect("turn task released its manager")
            .shutdown()
            .await;
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
            role: None,
        };

        let error = AgentManager::start(&RuntimeConfig::default(), &[&agent])
            .await
            .err()
            .expect("unknown runtime must fail session creation");
        let message = error.to_string();

        assert!(message.contains("Ghost"), "unattributed error: {message}");
        assert!(message.contains("mystery"), "missing runtime: {message}");
        assert!(
            message.contains("change this agent's runtime"),
            "missing remedy: {message}"
        );
    }
}
