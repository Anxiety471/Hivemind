//! Core-owned live runtime sessions, one per agent instance (`"{room}/{persona}"`).
//!
//! A session is a disposable cache of Hivemind-owned room context: the first
//! prompt of an epoch is a full Context Pack, later prompts are deltas bound to
//! that epoch. Sessions rotate at turn boundaries when their context grows past
//! the configured budget or a delta cannot be built, are discarded after any
//! runtime failure, close after an idle timeout, and stop on core shutdown.
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Weak,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use tokio::{sync::Mutex, task::JoinSet, time::timeout};

use super::{create_session, HarnessSession, ToolAccess};
use crate::{
    config::{AgentConfig, RuntimeConfig},
    events::{DomainEventKind, EventBus},
    memory::{Caller, MemoryService, RuntimeEpoch},
};

/// How long shutdown waits for a busy session before leaving it to stop
/// itself when its in-flight reply ends.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

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
    pub instance_id: &'a str,
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
    Failed,
    Idle,
    Shutdown,
}

struct Live {
    session: Box<dyn HarnessSession>,
    epoch: RuntimeEpoch,
    caller: Caller,
    agent_id: String,
    runtime: String,
    cursor: Option<TurnView>,
    estimated_tokens: u64,
    access: ToolAccess,
}

struct Slot {
    live: Option<Live>,
    last_used: Instant,
}

type SlotHandle = Arc<Mutex<Slot>>;

struct PoolInner {
    runtime: RuntimeConfig,
    rotate_tokens: u64,
    memory: Arc<MemoryService>,
    events: EventBus,
    slots: std::sync::Mutex<HashMap<String, SlotHandle>>,
    shutting_down: AtomicBool,
    reaper_started: AtomicBool,
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
        Self {
            inner: Arc::new(PoolInner {
                runtime,
                rotate_tokens: rotate_tokens as u64,
                memory,
                events,
                slots: std::sync::Mutex::new(HashMap::new()),
                shutting_down: AtomicBool::new(false),
                reaper_started: AtomicBool::new(false),
            }),
        }
    }

    /// Live continuable state for `instance_id`; `None` means the next prompt hydrates.
    pub async fn cursor(&self, instance_id: &str) -> Option<SessionCursor> {
        let slot = self.inner.existing_slot(instance_id)?;
        let slot = slot.lock().await;
        let live = slot.live.as_ref()?;
        Some(SessionCursor {
            epoch_id: live.epoch.id.clone(),
            view: live.cursor.clone()?,
        })
    }

    /// Prompt the instance's live session, starting, rotating, or rehydrating
    /// it as needed. A failed prompt discards the session and is not retried.
    ///
    /// `access` fixes what the runtime process may do to the workspace and is
    /// applied at launch; a live session started with different access is
    /// never reused.
    pub async fn invoke(
        &self,
        caller: &Caller,
        access: ToolAccess,
        request: InvokeRequest<'_>,
    ) -> Result<InvokeReply> {
        let inner = &self.inner;
        if inner.shutting_down.load(Ordering::SeqCst) {
            bail!("runtime pool is shutting down");
        }
        self.ensure_reaper();
        let slot = inner.slot(request.instance_id);
        let mut slot = slot.lock().await;
        // Shutdown may have drained this slot while we waited for its lock.
        if inner.shutting_down.load(Ordering::SeqCst) {
            bail!("runtime pool is shutting down");
        }

        let mut matching = matches!(
            (&request.delta, &slot.live),
            (Some(delta), Some(live)) if live.epoch.id == delta.epoch_id && live.access == access
        );
        if let Some(live) = slot.live.take() {
            if !matching {
                let reason = if live.access == access {
                    "context_gap"
                } else {
                    "tool_access"
                };
                inner
                    .stop(request.instance_id, live, Stop::Rotated(reason))
                    .await;
            } else if request.phase == PromptPhase::TurnStart {
                let mut live = live;
                let reported = live
                    .session
                    .context_tokens()
                    .await
                    .ok()
                    .flatten()
                    .unwrap_or(0);
                if live.estimated_tokens.max(reported) >= inner.rotate_tokens {
                    inner
                        .stop(request.instance_id, live, Stop::Rotated("context_budget"))
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
            slot.live = Some(inner.start(caller, access, &request).await?);
        }
        let text = match (matching, request.delta) {
            (true, Some(delta)) => delta.text,
            _ => request.full,
        };
        let mut live = slot.live.take().expect("live session was just ensured");
        match live.session.prompt(text).await {
            Ok(reply) => {
                live.estimated_tokens += (text.len() + reply.len()).div_ceil(4) as u64;
                live.cursor = Some(request.view.clone());
                slot.last_used = Instant::now();
                let epoch_id = live.epoch.id.clone();
                if inner.shutting_down.load(Ordering::SeqCst) {
                    inner.stop(request.instance_id, live, Stop::Shutdown).await;
                } else {
                    slot.live = Some(live);
                }
                Ok(InvokeReply {
                    text: reply,
                    epoch_id,
                })
            }
            Err(error) => {
                inner.events.publish(DomainEventKind::RuntimeFailed {
                    agent_id: live.agent_id.clone(),
                    instance_id: request.instance_id.to_owned(),
                    runtime: live.runtime.clone(),
                    error_code: "runtime_prompt_failed".into(),
                    message: "runtime session failed and was discarded".into(),
                });
                inner.stop(request.instance_id, live, Stop::Failed).await;
                Err(error)
            }
        }
    }

    /// Stop every idle session unused for at least `idle_for`; busy slots are skipped.
    pub async fn close_idle(&self, idle_for: Duration) {
        self.inner.close_idle(idle_for).await;
    }

    /// Idempotently stop every live session.
    pub async fn shutdown(&self) {
        let inner = &self.inner;
        if inner.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        let drained: Vec<(String, SlotHandle)> = inner
            .slots
            .lock()
            .expect("runtime pool slots lock poisoned")
            .drain()
            .collect();
        let mut tasks = JoinSet::new();
        for (instance_id, slot) in drained {
            let inner = inner.clone();
            tasks.spawn(async move {
                match timeout(SHUTDOWN_GRACE, slot.lock()).await {
                    Ok(mut slot) => {
                        if let Some(live) = slot.live.take() {
                            inner.stop(&instance_id, live, Stop::Shutdown).await;
                        }
                    }
                    Err(_) => eprintln!(
                        "warning: runtime '{instance_id}' still busy at shutdown; it stops when its reply ends"
                    ),
                }
            });
        }
        while tasks.join_next().await.is_some() {}
    }

    fn ensure_reaper(&self) {
        let idle = self.inner.runtime.idle_timeout_secs;
        if idle == 0 || self.inner.reaper_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak: Weak<PoolInner> = Arc::downgrade(&self.inner);
        let tick = Duration::from_secs((idle / 4).clamp(1, 30));
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(tick).await;
                let Some(inner) = weak.upgrade() else { break };
                if inner.shutting_down.load(Ordering::SeqCst) {
                    break;
                }
                inner.close_idle(Duration::from_secs(idle)).await;
            }
        });
    }
}

impl PoolInner {
    fn existing_slot(&self, instance_id: &str) -> Option<SlotHandle> {
        self.slots
            .lock()
            .expect("runtime pool slots lock poisoned")
            .get(instance_id)
            .cloned()
    }

    fn slot(&self, instance_id: &str) -> SlotHandle {
        self.slots
            .lock()
            .expect("runtime pool slots lock poisoned")
            .entry(instance_id.to_owned())
            .or_insert_with(|| {
                Arc::new(Mutex::new(Slot {
                    live: None,
                    last_used: Instant::now(),
                }))
            })
            .clone()
    }

    async fn start(
        &self,
        caller: &Caller,
        access: ToolAccess,
        request: &InvokeRequest<'_>,
    ) -> Result<Live> {
        let agent = request.agent;
        let mut session = match create_session(&self.runtime, agent, access).await {
            Ok(session) => session,
            Err(error) => {
                self.events.publish(DomainEventKind::RuntimeFailed {
                    agent_id: agent.name.clone(),
                    instance_id: request.instance_id.to_owned(),
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
                if let Err(stop_error) = session.shutdown().await {
                    eprintln!(
                        "warning: failed to stop runtime for '{}': {stop_error:#}",
                        request.instance_id
                    );
                }
                return Err(error);
            }
        };
        self.events.publish(DomainEventKind::RuntimeStarted {
            agent_id: agent.name.clone(),
            instance_id: request.instance_id.to_owned(),
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
            access,
        })
    }

    async fn stop(&self, instance_id: &str, mut live: Live, reason: Stop) {
        if let Err(error) = live.session.shutdown().await {
            eprintln!("warning: failed to stop runtime for '{instance_id}': {error:#}");
        }
        let ended_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        if let Err(error) = self
            .memory
            .end_runtime_epoch(&live.caller, &live.epoch.id, ended_at)
        {
            eprintln!("warning: failed to close runtime epoch for '{instance_id}': {error:#}");
        }
        self.events.publish(DomainEventKind::RuntimeStopped {
            agent_id: live.agent_id.clone(),
            instance_id: instance_id.to_owned(),
            runtime: live.runtime.clone(),
        });
        if let Stop::Rotated(reason) = reason {
            self.events.publish(DomainEventKind::RuntimeRotated {
                agent_id: live.agent_id,
                instance_id: instance_id.to_owned(),
                runtime: live.runtime,
                reason: reason.into(),
            });
        }
    }

    async fn close_idle(&self, idle_for: Duration) {
        let snapshot: Vec<(String, SlotHandle)> = self
            .slots
            .lock()
            .expect("runtime pool slots lock poisoned")
            .iter()
            .map(|(id, slot)| (id.clone(), slot.clone()))
            .collect();
        for (instance_id, slot) in snapshot {
            let Ok(mut slot) = slot.try_lock() else {
                continue;
            };
            if slot.live.is_some() && slot.last_used.elapsed() >= idle_for {
                let live = slot.live.take().expect("checked live session");
                self.stop(&instance_id, live, Stop::Idle).await;
            }
        }
    }
}
