//! Core-owned live runtime sessions, one per structured agent instance.
//!
//! A session is a disposable cache of Hivemind-owned room context: the first
//! prompt of an epoch is a full Context Pack, later prompts are deltas bound to
//! that epoch. Sessions rotate at turn boundaries when their context grows past
//! the configured budget or a delta cannot be built, are discarded after any
//! runtime failure, close after an idle timeout, and stop on core shutdown.
use std::{
    collections::HashMap,
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Weak,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use parking_lot::Mutex as ParkingMutex;
use tokio::{
    sync::{watch, Mutex as AsyncMutex},
    task::{JoinHandle, JoinSet},
    time::timeout,
};

use super::{create_session, HarnessSession};
use crate::{
    config::{AgentConfig, RuntimeConfig},
    events::{DomainEventKind, EventBus},
    identity::AgentInstanceId,
    memory::{Caller, MemoryService, RuntimeEpoch},
};

/// Pool shutdown cancels active work before waiting on each slot.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// Built-in child shutdown uses a 2s graceful exit; cap arbitrary sessions too.
const SESSION_SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptPhase {
    /// First prompt of a turn for this instance; rotation may happen before it.
    TurnStart,
    /// Follow-up inside a turn (memory-tool results); never rotates.
    InTurn,
}

/// Continuation prompt valid only for the live epoch it names.
#[derive(Debug, Clone, Copy)]
pub struct PromptDelta<'a> {
    pub epoch_id: &'a str,
    pub text: &'a str,
}

/// Room view a session holds: every event before the first event of
/// `turn_id`, plus the events of `turn_id` spoken by `speakers`, with
/// `state_json` as the shared state it was last shown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnView {
    pub turn_id: String,
    pub speakers: Vec<String>,
    pub state_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionCursor {
    pub epoch_id: String,
    pub view: TurnView,
}

pub struct InvokeRequest<'a> {
    pub agent_instance_id: &'a AgentInstanceId,
    pub agent: &'a AgentConfig,
    pub phase: PromptPhase,
    /// Self-contained prompt, sent whenever the session starts or rehydrates.
    pub full: &'a str,
    /// Continuation prompt, valid only for the live epoch it names.
    pub delta: Option<PromptDelta<'a>>,
    /// Room view the session holds after a successful reply.
    pub view: &'a TurnView,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvokeReply {
    pub text: String,
    pub epoch_id: String,
}

enum Stop {
    Rotated(&'static str),
    RuntimeFailure,
    PromptTimeout,
    IdleTimeout,
    CoreShutdown,
}

impl Stop {
    fn reason_code(&self) -> &'static str {
        match self {
            Self::Rotated(reason) => reason,
            Self::RuntimeFailure => "runtime_failure",
            Self::PromptTimeout => "prompt_timeout",
            Self::IdleTimeout => "idle_timeout",
            Self::CoreShutdown => "core_shutdown",
        }
    }
}

enum RuntimeCall<T> {
    Completed(Result<T>),
    TimedOut,
    Shutdown,
}

async fn race_runtime<T>(
    shutdown: &mut watch::Receiver<bool>,
    limit: Option<Duration>,
    future: impl Future<Output = Result<T>>,
) -> RuntimeCall<T> {
    if *shutdown.borrow() {
        return RuntimeCall::Shutdown;
    }
    match limit {
        Some(limit) => tokio::select! {
            biased;
            _ = shutdown.changed() => RuntimeCall::Shutdown,
            result = timeout(limit, future) => match result {
                Ok(result) => RuntimeCall::Completed(result),
                Err(_) => RuntimeCall::TimedOut,
            },
        },
        None => tokio::select! {
            biased;
            _ = shutdown.changed() => RuntimeCall::Shutdown,
            result = future => RuntimeCall::Completed(result),
        },
    }
}
async fn shutdown_session(session: &mut dyn HarnessSession, identity: &str) {
    match timeout(SESSION_SHUTDOWN_GRACE, session.shutdown()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("warning: failed to stop runtime for '{identity}': {error:#}"),
        Err(_) => {
            eprintln!("warning: runtime shutdown exceeded its bounded grace for '{identity}'")
        }
    }
}

struct Live {
    session: Box<dyn HarnessSession>,
    epoch: RuntimeEpoch,
    caller: Caller,
    agent_id: String,
    runtime: String,
    cursor: Option<TurnView>,
    estimated_tokens: u64,
}

struct Slot {
    live: Option<Live>,
    last_used: Instant,
}

type SlotHandle = Arc<AsyncMutex<Slot>>;

struct PoolInner {
    runtime: RuntimeConfig,
    rotate_tokens: u64,
    memory: Arc<MemoryService>,
    events: EventBus,
    slots: ParkingMutex<HashMap<AgentInstanceId, SlotHandle>>,
    shutting_down: AtomicBool,
    shutdown_signal: watch::Sender<bool>,
    shutdown_lock: AsyncMutex<()>,
    reaper_started: AtomicBool,
    reaper_task: ParkingMutex<Option<JoinHandle<()>>>,
}

/// Owns every live agent-instance runtime for one core.
pub struct RuntimePool {
    inner: Arc<PoolInner>,
}

impl RuntimePool {
    /// Build an empty pool; no session or task starts until the first invoke.
    pub fn new(
        runtime: RuntimeConfig,
        rotate_tokens: usize,
        memory: Arc<MemoryService>,
        events: EventBus,
    ) -> Self {
        let (shutdown_signal, _) = watch::channel(false);
        Self {
            inner: Arc::new(PoolInner {
                runtime,
                rotate_tokens: rotate_tokens as u64,
                memory,
                events,
                slots: ParkingMutex::new(HashMap::new()),
                shutting_down: AtomicBool::new(false),
                shutdown_signal,
                shutdown_lock: AsyncMutex::new(()),
                reaper_started: AtomicBool::new(false),
                reaper_task: ParkingMutex::new(None),
            }),
        }
    }

    /// Live continuable state for `agent_instance_id`; `None` means the next prompt hydrates.
    pub async fn cursor(&self, agent_instance_id: &AgentInstanceId) -> Option<SessionCursor> {
        let slot_handle = self.inner.existing_slot(agent_instance_id)?;
        let slot = slot_handle.lock().await;
        let Some(live) = slot.live.as_ref() else {
            self.inner
                .remove_vacant_slot(agent_instance_id, &slot_handle, &slot);
            return None;
        };
        Some(SessionCursor {
            epoch_id: live.epoch.id.clone(),
            view: live.cursor.clone()?,
        })
    }

    /// Prompt the instance's live session, starting, rotating, or rehydrating
    /// it as needed. A failed prompt discards the session and is not retried.
    pub async fn invoke(&self, caller: &Caller, request: InvokeRequest<'_>) -> Result<InvokeReply> {
        if caller.agent_instance_id != *request.agent_instance_id
            || caller.room_id != request.agent_instance_id.room_id
            || caller.persona_id != request.agent_instance_id.persona_id
            || request.agent.name != request.agent_instance_id.persona_id
        {
            bail!("runtime request identity does not match its caller and persona");
        }
        let inner = &self.inner;
        let mut shutdown = inner.shutdown_signal.subscribe();
        if *shutdown.borrow() || inner.shutting_down.load(Ordering::SeqCst) {
            bail!("runtime pool is shutting down");
        }
        self.ensure_reaper();
        let slot_handle = inner
            .slot(request.agent_instance_id)
            .ok_or_else(|| anyhow::anyhow!("runtime pool is shutting down"))?;
        let mut slot = tokio::select! {
            biased;
            _ = shutdown.changed() => bail!("runtime pool is shutting down"),
            slot = slot_handle.lock() => slot,
        };
        if *shutdown.borrow() || inner.shutting_down.load(Ordering::SeqCst) {
            bail!("runtime pool is shutting down");
        }

        let mut matching = matches!(
            (&request.delta, &slot.live),
            (Some(delta), Some(live)) if live.epoch.id == delta.epoch_id
        );
        let prompt_timeout = (inner.runtime.prompt_timeout_secs > 0)
            .then(|| Duration::from_secs(inner.runtime.prompt_timeout_secs));
        if let Some(live) = slot.live.take() {
            if !matching {
                inner
                    .stop(
                        request.agent_instance_id,
                        live,
                        Stop::Rotated("context_gap"),
                    )
                    .await;
            } else if request.phase == PromptPhase::TurnStart {
                let mut live = live;
                let reported = match race_runtime(
                    &mut shutdown,
                    prompt_timeout,
                    live.session.context_tokens(),
                )
                .await
                {
                    RuntimeCall::Completed(result) => result.ok().flatten().unwrap_or(0),
                    RuntimeCall::TimedOut => {
                        inner.publish_failure(
                            request.agent_instance_id,
                            &live,
                            "prompt_timeout",
                            "runtime context query timed out and was discarded",
                        );
                        inner
                            .stop(request.agent_instance_id, live, Stop::PromptTimeout)
                            .await;
                        inner.remove_vacant_slot(request.agent_instance_id, &slot_handle, &slot);
                        bail!("runtime context query timed out");
                    }
                    RuntimeCall::Shutdown => {
                        inner
                            .stop(request.agent_instance_id, live, Stop::CoreShutdown)
                            .await;
                        bail!("runtime pool is shutting down");
                    }
                };
                if live.estimated_tokens.max(reported) >= inner.rotate_tokens {
                    inner
                        .stop(
                            request.agent_instance_id,
                            live,
                            Stop::Rotated("context_budget"),
                        )
                        .await;
                    matching = false;
                } else {
                    slot.live = Some(live);
                }
            } else {
                slot.live = Some(live);
            }
        }

        if slot.live.is_none() {
            let starting = inner.start(caller, &request);
            match race_runtime(&mut shutdown, None, starting).await {
                RuntimeCall::Completed(Ok(live)) => slot.live = Some(live),
                RuntimeCall::Completed(Err(error)) => {
                    inner.remove_vacant_slot(request.agent_instance_id, &slot_handle, &slot);
                    return Err(error);
                }
                RuntimeCall::Shutdown => bail!("runtime pool is shutting down"),
                RuntimeCall::TimedOut => unreachable!("session start has no timeout"),
            }
        }
        let text = match (matching, request.delta) {
            (true, Some(delta)) => delta.text,
            _ => request.full,
        };
        let mut live = slot.live.take().expect("live session was just ensured");
        match race_runtime(&mut shutdown, prompt_timeout, live.session.prompt(text)).await {
            RuntimeCall::Completed(Ok(reply)) => {
                live.estimated_tokens += (text.len() + reply.len()).div_ceil(4) as u64;
                live.cursor = Some(request.view.clone());
                slot.last_used = Instant::now();
                let epoch_id = live.epoch.id.clone();
                if inner.shutting_down.load(Ordering::SeqCst) {
                    inner
                        .stop(request.agent_instance_id, live, Stop::CoreShutdown)
                        .await;
                } else {
                    slot.live = Some(live);
                }
                Ok(InvokeReply {
                    text: reply,
                    epoch_id,
                })
            }
            RuntimeCall::Completed(Err(error)) => {
                inner.publish_failure(
                    request.agent_instance_id,
                    &live,
                    "runtime_failure",
                    "runtime session failed and was discarded",
                );
                inner
                    .stop(request.agent_instance_id, live, Stop::RuntimeFailure)
                    .await;
                inner.remove_vacant_slot(request.agent_instance_id, &slot_handle, &slot);
                Err(error)
            }
            RuntimeCall::TimedOut => {
                inner.publish_failure(
                    request.agent_instance_id,
                    &live,
                    "prompt_timeout",
                    "runtime prompt timed out and was discarded",
                );
                inner
                    .stop(request.agent_instance_id, live, Stop::PromptTimeout)
                    .await;
                inner.remove_vacant_slot(request.agent_instance_id, &slot_handle, &slot);
                bail!("runtime prompt timed out");
            }
            RuntimeCall::Shutdown => {
                inner
                    .stop(request.agent_instance_id, live, Stop::CoreShutdown)
                    .await;
                bail!("runtime pool is shutting down");
            }
        }
    }

    /// Stop every idle session unused for at least `idle_for`; busy slots are skipped.
    pub async fn close_idle(&self, idle_for: Duration) {
        self.inner.close_idle(idle_for).await;
    }
    #[cfg(test)]
    pub(crate) fn slot_count(&self) -> usize {
        self.inner.slots.lock().len()
    }

    /// Idempotently stop every live session.
    pub async fn shutdown(&self) {
        let inner = &self.inner;
        let _shutdown_guard = inner.shutdown_lock.lock().await;
        let drained = {
            let mut slots = inner.slots.lock();
            if inner.shutting_down.swap(true, Ordering::SeqCst) {
                return;
            }
            inner.shutdown_signal.send_replace(true);
            slots.drain().collect::<Vec<_>>()
        };
        let mut tasks = JoinSet::new();
        for (agent_instance_id, slot) in drained {
            let inner = inner.clone();
            tasks.spawn(async move {
                match timeout(SHUTDOWN_GRACE, slot.lock()).await {
                    Ok(mut slot) => {
                        if let Some(live) = slot.live.take() {
                            inner
                                .stop(&agent_instance_id, live, Stop::CoreShutdown)
                                .await;
                        }
                    }
                    Err(_) => eprintln!(
                        "warning: runtime '{}' did not release its slot during shutdown",
                        agent_instance_id.encode()
                    ),
                }
            });
        }
        while tasks.join_next().await.is_some() {}
        let reaper = inner.reaper_task.lock().take();
        if let Some(reaper) = reaper {
            let _ = reaper.await;
        }
    }
    fn ensure_reaper(&self) {
        let idle = self.inner.runtime.idle_timeout_secs;
        if idle == 0 || self.inner.reaper_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak: Weak<PoolInner> = Arc::downgrade(&self.inner);
        let mut shutdown = self.inner.shutdown_signal.subscribe();
        let tick = Duration::from_secs((idle / 4).clamp(1, 30));
        let reaper = tokio::spawn(async move {
            loop {
                if *shutdown.borrow() {
                    break;
                }
                tokio::select! {
                    biased;
                    _ = shutdown.changed() => break,
                    _ = tokio::time::sleep(tick) => {}
                }
                if *shutdown.borrow() {
                    break;
                }
                let Some(inner) = weak.upgrade() else { break };
                if inner.shutting_down.load(Ordering::SeqCst) {
                    break;
                }
                inner.close_idle(Duration::from_secs(idle)).await;
            }
        });
        *self.inner.reaper_task.lock() = Some(reaper);
    }
}

impl PoolInner {
    fn existing_slot(&self, agent_instance_id: &AgentInstanceId) -> Option<SlotHandle> {
        self.slots.lock().get(agent_instance_id).cloned()
    }
    fn publish_failure(
        &self,
        agent_instance_id: &AgentInstanceId,
        live: &Live,
        error_code: &str,
        message: &str,
    ) {
        self.events.publish(DomainEventKind::RuntimeFailed {
            agent_id: live.agent_id.clone(),
            agent_instance_id: agent_instance_id.clone(),
            runtime: live.runtime.clone(),
            error_code: error_code.into(),
            message: message.into(),
        });
    }

    fn slot(&self, agent_instance_id: &AgentInstanceId) -> Option<SlotHandle> {
        let mut slots = self.slots.lock();
        if self.shutting_down.load(Ordering::SeqCst) {
            return None;
        }
        Some(
            slots
                .entry(agent_instance_id.clone())
                .or_insert_with(|| {
                    Arc::new(AsyncMutex::new(Slot {
                        live: None,
                        last_used: Instant::now(),
                    }))
                })
                .clone(),
        )
    }

    async fn start(&self, caller: &Caller, request: &InvokeRequest<'_>) -> Result<Live> {
        let agent = request.agent;
        let mut session = match create_session(&self.runtime, agent).await {
            Ok(session) => session,
            Err(error) => {
                self.events.publish(DomainEventKind::RuntimeFailed {
                    agent_id: agent.name.clone(),
                    agent_instance_id: request.agent_instance_id.clone(),
                    runtime: agent.runtime.clone(),
                    error_code: "runtime_start_failed".into(),
                    message: "runtime session could not be started".into(),
                });
                return Err(error);
            }
        };
        let epoch = match self
            .memory
            .start_runtime_epoch(
                caller,
                agent.runtime.trim(),
                serde_json::json!({ "kind": "session", "agent": agent.name }),
            )
            .context("recording runtime epoch start")
        {
            Ok(epoch) => epoch,
            Err(error) => {
                shutdown_session(&mut *session, &request.agent_instance_id.encode()).await;
                return Err(error);
            }
        };
        self.events.publish(DomainEventKind::RuntimeStarted {
            agent_id: agent.name.clone(),
            agent_instance_id: request.agent_instance_id.clone(),
            runtime: agent.runtime.clone(),
        });
        Ok(Live {
            session,
            epoch,
            caller: caller.clone(),
            agent_id: agent.name.clone(),
            runtime: agent.runtime.clone(),
            cursor: None,
            estimated_tokens: 0,
        })
    }

    async fn stop(&self, agent_instance_id: &AgentInstanceId, mut live: Live, reason: Stop) {
        shutdown_session(&mut *live.session, &agent_instance_id.encode()).await;
        let ended_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        if let Err(error) = self
            .memory
            .end_runtime_epoch(&live.caller, &live.epoch.id, ended_at)
        {
            eprintln!(
                "warning: failed to close runtime epoch for '{}': {error:#}",
                agent_instance_id.encode()
            );
        }
        self.events.publish(DomainEventKind::RuntimeStopped {
            agent_id: live.agent_id.clone(),
            agent_instance_id: agent_instance_id.clone(),
            runtime: live.runtime.clone(),
            reason: reason.reason_code().into(),
        });
        if let Stop::Rotated(reason) = reason {
            self.events.publish(DomainEventKind::RuntimeRotated {
                agent_id: live.agent_id,
                agent_instance_id: agent_instance_id.clone(),
                runtime: live.runtime,
                reason: reason.into(),
            });
        }
    }

    async fn close_idle(&self, idle_for: Duration) {
        let snapshot: Vec<(AgentInstanceId, SlotHandle)> = self
            .slots
            .lock()
            .iter()
            .map(|(id, slot)| (id.clone(), slot.clone()))
            .collect();
        for (agent_instance_id, slot_handle) in snapshot {
            if self.shutting_down.load(Ordering::SeqCst) {
                break;
            }
            let Ok(mut slot) = slot_handle.try_lock() else {
                continue;
            };
            if slot.live.is_none() {
                self.remove_vacant_slot(&agent_instance_id, &slot_handle, &slot);
                continue;
            }
            if slot.last_used.elapsed() < idle_for {
                continue;
            }
            let live = slot.live.take().expect("checked live session");
            self.stop(&agent_instance_id, live, Stop::IdleTimeout).await;
            self.remove_vacant_slot(&agent_instance_id, &slot_handle, &slot);
        }
    }

    fn remove_vacant_slot(
        &self,
        agent_instance_id: &AgentInstanceId,
        slot_handle: &SlotHandle,
        slot: &Slot,
    ) {
        if slot.live.is_some() {
            return;
        }
        let mut slots = self.slots.lock();
        let removable = Arc::strong_count(slot_handle) == 2
            && slots
                .get(agent_instance_id)
                .is_some_and(|current| Arc::ptr_eq(current, slot_handle));
        if removable {
            slots.remove(agent_instance_id);
        }
    }
}
impl Drop for PoolInner {
    fn drop(&mut self) {
        self.shutdown_signal.send_replace(true);
        let ended_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        for (agent_instance_id, slot_handle) in self.slots.get_mut() {
            let Ok(mut slot) = slot_handle.try_lock() else {
                continue;
            };
            let Some(live) = slot.live.take() else {
                continue;
            };
            if let Err(error) =
                self.memory
                    .end_runtime_epoch(&live.caller, &live.epoch.id, ended_at)
            {
                eprintln!(
                    "warning: failed to close runtime epoch for '{}': {error:#}",
                    agent_instance_id.encode()
                );
            }
            self.events.publish(DomainEventKind::RuntimeStopped {
                agent_id: live.agent_id.clone(),
                agent_instance_id: agent_instance_id.clone(),
                runtime: live.runtime.clone(),
                reason: "core_shutdown".into(),
            });
            // Dropping the session triggers each built-in child's kill_on_drop fallback.
        }
    }
}
#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;

    use super::*;
    use crate::memory::MemoryStore;

    struct FakeSession(Arc<AtomicUsize>);

    #[async_trait]
    impl HarnessSession for FakeSession {
        async fn prompt(&mut self, _input: &str) -> anyhow::Result<String> {
            Ok("reply".into())
        }

        async fn context_tokens(&mut self) -> anyhow::Result<Option<u64>> {
            Ok(None)
        }

        async fn shutdown(&mut self) -> anyhow::Result<()> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }
    struct GatedSession {
        shutdown_started: Arc<tokio::sync::Notify>,
        shutdown_release: Arc<tokio::sync::Notify>,
    }

    #[async_trait]
    impl HarnessSession for GatedSession {
        async fn prompt(&mut self, _input: &str) -> anyhow::Result<String> {
            Ok("reply".into())
        }

        async fn context_tokens(&mut self) -> anyhow::Result<Option<u64>> {
            Ok(None)
        }

        async fn shutdown(&mut self) -> anyhow::Result<()> {
            self.shutdown_started.notify_one();
            self.shutdown_release.notified().await;
            Ok(())
        }
    }

    struct HungStatsSession(Arc<AtomicUsize>);

    #[async_trait]
    impl HarnessSession for HungStatsSession {
        async fn prompt(&mut self, _input: &str) -> anyhow::Result<String> {
            Ok("reply".into())
        }

        async fn context_tokens(&mut self) -> anyhow::Result<Option<u64>> {
            std::future::pending().await
        }

        async fn shutdown(&mut self) -> anyhow::Result<()> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[tokio::test]
    async fn hung_context_query_times_out_and_discards_the_session() {
        let memory = Arc::new(MemoryService::new(MemoryStore::in_memory().unwrap()));
        let instance = AgentInstanceId::new("stats-room", "Persona");
        let caller = Caller::agent("stats-room", "", instance.clone(), "Persona", "Persona");
        let epoch = memory
            .start_runtime_epoch(&caller, "fake", serde_json::json!({}))
            .unwrap();
        let epoch_id = epoch.id.clone();
        let runtime = RuntimeConfig {
            idle_timeout_secs: 0,
            prompt_timeout_secs: 1,
            ..RuntimeConfig::default()
        };
        let pool = RuntimePool::new(runtime, 10_000, memory, EventBus::new());
        let shutdowns = Arc::new(AtomicUsize::new(0));
        pool.inner.slots.lock().insert(
            instance.clone(),
            Arc::new(AsyncMutex::new(Slot {
                live: Some(Live {
                    session: Box::new(HungStatsSession(shutdowns.clone())),
                    epoch,
                    caller: caller.clone(),
                    agent_id: "Persona".into(),
                    runtime: "fake".into(),
                    cursor: None,
                    estimated_tokens: 0,
                }),
                last_used: Instant::now(),
            })),
        );
        let mut events = pool.inner.events.subscribe();
        let agent = AgentConfig {
            name: "Persona".into(),
            runtime: "unsupported".into(),
            system_prompt: String::new(),
            workspace: ".".into(),
            model: None,
            reasoning: None,
            fast: None,
            role: None,
        };
        let view = TurnView {
            turn_id: "turn".into(),
            speakers: vec![],
            state_json: "{}".into(),
        };
        let error = tokio::time::timeout(
            Duration::from_secs(10),
            pool.invoke(
                &caller,
                InvokeRequest {
                    agent_instance_id: &instance,
                    agent: &agent,
                    phase: PromptPhase::TurnStart,
                    full: "full",
                    delta: Some(PromptDelta {
                        epoch_id: &epoch_id,
                        text: "delta",
                    }),
                    view: &view,
                },
            ),
        )
        .await
        .expect("context query is bounded by the prompt timeout")
        .unwrap_err();
        assert!(error.to_string().contains("context query timed out"));
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
        assert!(pool.inner.existing_slot(&instance).is_none());
        let epochs = pool.inner.memory.runtime_epochs(&caller, 10).unwrap();
        assert_eq!(epochs.len(), 1);
        assert!(epochs[0].ended_at.is_some());
        let mut reasons = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let DomainEventKind::RuntimeStopped { reason, .. } = &event.payload {
                reasons.push(reason.clone());
            }
        }
        assert_eq!(reasons, ["prompt_timeout"]);
    }

    fn idle_pool_with_live_session() -> (RuntimePool, Caller, AgentInstanceId, Arc<AtomicUsize>) {
        let memory = Arc::new(MemoryService::new(MemoryStore::in_memory().unwrap()));
        let instance = AgentInstanceId::new("idle-room", "Persona");
        let caller = Caller::agent("idle-room", "", instance.clone(), "Persona", "Persona");
        let epoch = memory
            .start_runtime_epoch(&caller, "fake", serde_json::json!({}))
            .unwrap();
        let runtime = RuntimeConfig {
            idle_timeout_secs: 0,
            ..RuntimeConfig::default()
        };
        let pool = RuntimePool::new(runtime, 10_000, memory, EventBus::new());
        let shutdowns = Arc::new(AtomicUsize::new(0));
        let slot = Arc::new(AsyncMutex::new(Slot {
            live: Some(Live {
                session: Box::new(FakeSession(shutdowns.clone())),
                epoch,
                caller: caller.clone(),
                agent_id: "Persona".into(),
                runtime: "fake".into(),
                cursor: None,
                estimated_tokens: 0,
            }),
            last_used: Instant::now() - Duration::from_secs(120),
        }));
        pool.inner.slots.lock().insert(instance.clone(), slot);
        (pool, caller, instance, shutdowns)
    }

    fn empty_pool(idle_timeout_secs: u64) -> RuntimePool {
        let memory = Arc::new(MemoryService::new(MemoryStore::in_memory().unwrap()));
        let runtime = RuntimeConfig {
            idle_timeout_secs,
            ..RuntimeConfig::default()
        };
        RuntimePool::new(runtime, 10_000, memory, EventBus::new())
    }

    #[tokio::test]
    async fn idle_stop_closes_epoch_and_evicts_vacant_slot_safely() {
        let (pool, caller, instance, shutdowns) = idle_pool_with_live_session();
        let mut events = pool.inner.events.subscribe();
        let queued_caller = pool.inner.existing_slot(&instance).unwrap();

        pool.close_idle(Duration::ZERO).await;
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
        assert!(pool.inner.existing_slot(&instance).is_some());

        let epoch = pool
            .inner
            .memory
            .start_runtime_epoch(&caller, "fake", serde_json::json!({}))
            .unwrap();
        {
            let mut slot = queued_caller.lock().await;
            slot.last_used = Instant::now();
            slot.live = Some(Live {
                session: Box::new(FakeSession(shutdowns.clone())),
                epoch,
                caller: caller.clone(),
                agent_id: "Persona".into(),
                runtime: "fake".into(),
                cursor: None,
                estimated_tokens: 0,
            });
        }
        pool.close_idle(Duration::from_secs(60)).await;
        let current = pool.inner.existing_slot(&instance).unwrap();
        assert!(Arc::ptr_eq(&current, &queued_caller));
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
        drop(current);

        drop(queued_caller);
        pool.close_idle(Duration::ZERO).await;
        assert!(pool.inner.existing_slot(&instance).is_none());
        assert_eq!(shutdowns.load(Ordering::SeqCst), 2);
        let epochs = pool.inner.memory.runtime_epochs(&caller, 10).unwrap();
        assert_eq!(epochs.len(), 2);
        assert!(epochs.iter().all(|epoch| epoch.ended_at.is_some()));
        let mut reasons = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let DomainEventKind::RuntimeStopped { reason, .. } = &event.payload {
                reasons.push(reason.clone());
            }
        }
        assert_eq!(reasons, ["idle_timeout", "idle_timeout"]);
    }

    #[tokio::test]
    async fn cursor_evicts_a_vacant_slot_after_terminal_cleanup_skips_a_waiter() {
        let (pool, _caller, instance, shutdowns) = idle_pool_with_live_session();
        let pool = Arc::new(pool);
        let slot_handle = pool.inner.existing_slot(&instance).unwrap();
        let mut slot = slot_handle.lock().await;

        let cursor_pool = pool.clone();
        let cursor_instance = instance.clone();
        let cursor = tokio::spawn(async move { cursor_pool.cursor(&cursor_instance).await });
        tokio::time::timeout(Duration::from_secs(1), async {
            while Arc::strong_count(&slot_handle) < 3 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cursor holds a clone while waiting for the slot");

        let live = slot.live.take().unwrap();
        pool.inner.stop(&instance, live, Stop::PromptTimeout).await;
        pool.inner
            .remove_vacant_slot(&instance, &slot_handle, &slot);
        assert!(pool.inner.existing_slot(&instance).is_some());
        drop(slot);
        drop(slot_handle);

        tokio::time::timeout(Duration::from_secs(1), cursor)
            .await
            .expect("cursor observes the stopped session")
            .unwrap();
        assert!(pool.inner.existing_slot(&instance).is_none());
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn shutdown_cancels_a_caller_waiting_for_the_slot_lock() {
        let (pool, caller, instance, shutdowns) = idle_pool_with_live_session();
        let pool = Arc::new(pool);
        let slot_handle = pool.inner.existing_slot(&instance).unwrap();
        let held_slot = slot_handle.lock().await;
        let mut events = pool.inner.events.subscribe();

        let invoke_pool = pool.clone();
        let invoke_caller = caller.clone();
        let invoke_instance = instance.clone();
        let invoke = tokio::spawn(async move {
            let agent = AgentConfig {
                name: "Persona".into(),
                runtime: "unsupported".into(),
                system_prompt: String::new(),
                workspace: ".".into(),
                model: None,
                reasoning: None,
                fast: None,
                role: None,
            };
            let view = TurnView {
                turn_id: "turn".into(),
                speakers: vec![],
                state_json: "{}".into(),
            };
            invoke_pool
                .invoke(
                    &invoke_caller,
                    InvokeRequest {
                        agent_instance_id: &invoke_instance,
                        agent: &agent,
                        phase: PromptPhase::TurnStart,
                        full: "hello",
                        delta: None,
                        view: &view,
                    },
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while Arc::strong_count(&slot_handle) < 3 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("invoke cloned the slot before waiting for its lock");

        let mut shutdown_signal = pool.inner.shutdown_signal.subscribe();
        let shutdown_pool = pool.clone();
        let shutdown = tokio::spawn(async move {
            shutdown_pool.shutdown().await;
        });
        tokio::time::timeout(Duration::from_secs(1), shutdown_signal.changed())
            .await
            .expect("shutdown signaled the queued invoke")
            .unwrap();
        drop(held_slot);

        let error = tokio::time::timeout(Duration::from_secs(1), invoke)
            .await
            .expect("slot waiter is canceled promptly")
            .unwrap()
            .unwrap_err();
        assert!(error.to_string().contains("shutting down"));
        tokio::time::timeout(Duration::from_secs(5), shutdown)
            .await
            .expect("pool shutdown waits for the acquired slot to stop")
            .unwrap();
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
        let epochs = pool.inner.memory.runtime_epochs(&caller, 10).unwrap();
        assert_eq!(epochs.len(), 1);
        assert!(epochs[0].ended_at.is_some());
        let stopped = events.try_recv().unwrap();
        assert!(matches!(
            &stopped.payload,
            DomainEventKind::RuntimeStopped {
                reason,
                ..
            } if reason == "core_shutdown"
        ));
    }

    #[test]
    fn dropping_pool_closes_open_runtime_epochs() {
        let (pool, caller, _instance, _shutdowns) = idle_pool_with_live_session();
        let memory = pool.inner.memory.clone();
        let mut events = pool.inner.events.subscribe();

        drop(pool);

        let epochs = memory.runtime_epochs(&caller, 10).unwrap();
        assert_eq!(epochs.len(), 1);
        assert!(epochs[0].ended_at.is_some());
        let stopped = events.try_recv().unwrap();
        assert!(matches!(
            &stopped.payload,
            DomainEventKind::RuntimeStopped {
                reason,
                ..
            } if reason == "core_shutdown"
        ));
    }

    #[tokio::test]
    async fn idle_scan_stops_after_shutdown_begins() {
        let memory = Arc::new(MemoryService::new(MemoryStore::in_memory().unwrap()));
        let pool = RuntimePool::new(
            RuntimeConfig {
                idle_timeout_secs: 0,
                ..RuntimeConfig::default()
            },
            10_000,
            memory.clone(),
            EventBus::new(),
        );
        let shutdown_started = Arc::new(tokio::sync::Notify::new());
        let shutdown_release = Arc::new(tokio::sync::Notify::new());
        let second_shutdowns = Arc::new(AtomicUsize::new(0));
        let first_id = AgentInstanceId::new("first-room", "Persona");
        let second_id = AgentInstanceId::new("second-room", "Persona");
        let first_caller = Caller::agent("first-room", "", first_id.clone(), "Persona", "Persona");
        let second_caller =
            Caller::agent("second-room", "", second_id.clone(), "Persona", "Persona");
        let first_epoch = memory
            .start_runtime_epoch(&first_caller, "fake", serde_json::json!({}))
            .unwrap();
        let second_epoch = memory
            .start_runtime_epoch(&second_caller, "fake", serde_json::json!({}))
            .unwrap();
        pool.inner.slots.lock().insert(
            first_id,
            Arc::new(AsyncMutex::new(Slot {
                live: Some(Live {
                    session: Box::new(GatedSession {
                        shutdown_started: shutdown_started.clone(),
                        shutdown_release: shutdown_release.clone(),
                    }),
                    epoch: first_epoch,
                    caller: first_caller,
                    agent_id: "Persona".into(),
                    runtime: "fake".into(),
                    cursor: None,
                    estimated_tokens: 0,
                }),
                last_used: Instant::now() - Duration::from_secs(120),
            })),
        );
        let second_slot = Arc::new(AsyncMutex::new(Slot {
            live: Some(Live {
                session: Box::new(FakeSession(second_shutdowns.clone())),
                epoch: second_epoch,
                caller: second_caller,
                agent_id: "Persona".into(),
                runtime: "fake".into(),
                cursor: None,
                estimated_tokens: 0,
            }),
            last_used: Instant::now() - Duration::from_secs(120),
        }));
        pool.inner
            .slots
            .lock()
            .insert(second_id, second_slot.clone());

        let held_second = second_slot.lock().await;
        let scan_inner = pool.inner.clone();
        let scan = tokio::spawn(async move {
            scan_inner.close_idle(Duration::ZERO).await;
        });
        tokio::time::timeout(Duration::from_secs(1), shutdown_started.notified())
            .await
            .expect("idle scan is stopping its first live session");
        pool.inner.shutting_down.store(true, Ordering::SeqCst);
        drop(held_second);
        shutdown_release.notify_one();
        tokio::time::timeout(Duration::from_secs(1), scan)
            .await
            .expect("idle scan stops after the current session")
            .unwrap();
        assert_eq!(second_shutdowns.load(Ordering::SeqCst), 0);

        pool.inner.shutting_down.store(false, Ordering::SeqCst);
        pool.shutdown().await;
        assert_eq!(second_shutdowns.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn idle_reaper_ends_on_shutdown_drop_and_is_disabled_with_idle_timeout() {
        let disabled = empty_pool(0);
        disabled.ensure_reaper();
        assert!(!disabled.inner.reaper_started.load(Ordering::SeqCst));
        assert!(disabled.inner.reaper_task.lock().is_none());

        let pool = empty_pool(120);
        pool.ensure_reaper();
        assert!(pool.inner.reaper_started.load(Ordering::SeqCst));
        assert!(pool.inner.reaper_task.lock().is_some());
        pool.shutdown().await;
        assert!(pool.inner.reaper_task.lock().is_none());

        let dropped = empty_pool(120);
        dropped.ensure_reaper();
        let reaper = dropped.inner.reaper_task.lock().take().unwrap();
        drop(dropped);
        tokio::time::timeout(Duration::from_secs(1), reaper)
            .await
            .expect("pool drop signals the reaper to stop")
            .unwrap();
    }
}
