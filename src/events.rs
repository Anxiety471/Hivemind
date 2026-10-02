//! Ephemeral process-local domain notifications. Events are not canonical state or history.
use crate::identity::AgentInstanceId;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

const EVENT_CAPACITY: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainEvent {
    pub event_id: String,
    pub sequence: u64,
    pub occurred_at: SystemTime,
    pub payload: DomainEventKind,
    /// Wire frame encoded at most once, by whichever subscriber needs it first; `None` = not public.
    #[serde(skip)]
    frame: OnceLock<Option<String>>,
}

impl DomainEvent {
    pub fn new(
        event_id: String,
        sequence: u64,
        occurred_at: SystemTime,
        payload: DomainEventKind,
    ) -> Self {
        Self {
            event_id,
            sequence,
            occurred_at,
            payload,
            frame: OnceLock::new(),
        }
    }

    /// Returns the serialized frame shared by all subscribers, running `encode` only on first use.
    pub fn frame_with(&self, encode: impl FnOnce(&Self) -> Option<String>) -> Option<&str> {
        self.frame.get_or_init(|| encode(self)).as_deref()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DomainEventKind {
    RuntimeProgress {
        room_id: String,
        turn_id: String,
        agent_instance_id: AgentInstanceId,
        kind: String,
        message_id: String,
        text: String,
    },
    CoreStarted,
    CoreShuttingDown,
    ThreadCreated {
        thread_id: String,
        parent_room_id: String,
        anchor_message_id: String,
    },
    TurnStarted {
        turn_id: String,
        room_id: String,
    },
    TurnCompleted {
        turn_id: String,
        room_id: String,
        reply_count: usize,
    },
    AgentReplyStarted {
        turn_id: String,
        room_id: String,
        agent_id: String,
        agent_instance_id: AgentInstanceId,
    },
    AgentReplyCompleted {
        turn_id: String,
        room_id: String,
        agent_id: String,
        agent_instance_id: AgentInstanceId,
    },
    AgentReplyFailed {
        turn_id: String,
        room_id: String,
        agent_id: String,
        agent_instance_id: AgentInstanceId,
        error_code: String,
        message: String,
    },
    RuntimeStarted {
        agent_id: String,
        agent_instance_id: AgentInstanceId,
        runtime: String,
    },
    RuntimeStopped {
        agent_id: String,
        agent_instance_id: AgentInstanceId,
        runtime: String,
        reason: String,
    },
    RuntimeFailed {
        agent_id: String,
        agent_instance_id: AgentInstanceId,
        runtime: String,
        error_code: String,
        message: String,
    },
    RuntimeRotated {
        agent_id: String,
        agent_instance_id: AgentInstanceId,
        runtime: String,
        reason: String,
    },
    /// A committed coordination event (task, attempt, message, or group); `seq` is the durable sequence.
    Coordination {
        seq: i64,
        root_id: String,
        task_id: Option<String>,
        event_type: String,
        actor: String,
        payload: serde_json::Value,
    },
}

#[derive(Clone)]
pub struct EventBus {
    sender: broadcast::Sender<Arc<DomainEvent>>,
    sequence: Arc<Mutex<u64>>,
    active: Arc<Mutex<std::collections::HashMap<String, Vec<String>>>>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventBus {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(EVENT_CAPACITY);
        Self {
            sender,
            sequence: Arc::new(Mutex::new(0)),
            active: Arc::default(),
        }
    }

    /// Each subscriber receives an independent bounded stream. Slow consumers must handle `RecvError::Lagged`.
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<DomainEvent>> {
        self.sender.subscribe()
    }

    /// Personas whose reply is running in `room`, in start order. Rebuilt from the
    /// same events subscribers see, so a UI that was away can recover what is in flight.
    pub fn active_replies(&self, room: &str) -> Vec<String> {
        let active = self.active.lock().unwrap_or_else(|p| p.into_inner());
        active.get(room).cloned().unwrap_or_default()
    }

    fn track(&self, payload: &DomainEventKind) {
        let mut active = self.active.lock().unwrap_or_else(|p| p.into_inner());
        match payload {
            DomainEventKind::AgentReplyStarted {
                room_id, agent_id, ..
            } => {
                let agents = active.entry(room_id.clone()).or_default();
                if !agents.contains(agent_id) {
                    agents.push(agent_id.clone());
                }
            }
            DomainEventKind::AgentReplyCompleted {
                room_id, agent_id, ..
            }
            | DomainEventKind::AgentReplyFailed {
                room_id, agent_id, ..
            } => {
                if let Some(agents) = active.get_mut(room_id) {
                    agents.retain(|agent| agent != agent_id);
                }
            }
            // A cancelled or crashed turn never reports its replies; the next
            // turn in the room (serialized per room) starts from a clean slate.
            DomainEventKind::TurnStarted { room_id, .. }
            | DomainEventKind::TurnCompleted { room_id, .. } => {
                active.remove(room_id);
            }
            _ => {}
        }
        active.retain(|_, agents| !agents.is_empty());
    }

    /// Publish without waiting; events may be dropped for lagging subscribers.
    pub fn publish(&self, payload: DomainEventKind) {
        self.track(&payload);
        let mut next = self
            .sequence
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *next += 1;
        let sequence = *next;
        let event = Arc::new(DomainEvent::new(
            format!("evt-{sequence}"),
            sequence,
            SystemTime::now(),
            payload,
        ));
        let _ = self.sender.send(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::broadcast::error::TryRecvError;

    #[test]
    fn subscriptions_are_independent_and_sequence_is_monotonic() {
        let bus = EventBus::new();
        let mut first = bus.subscribe();
        let mut second = bus.subscribe();
        bus.publish(DomainEventKind::CoreStarted);
        bus.publish(DomainEventKind::CoreShuttingDown);
        let one = first.try_recv().unwrap();
        let two = first.try_recv().unwrap();
        assert_eq!((one.sequence, two.sequence), (1, 2));
        assert_ne!(one.event_id, two.event_id);
        assert!(one.occurred_at <= two.occurred_at);
        assert_eq!(second.try_recv().unwrap().sequence, 1);
        assert_eq!(second.try_recv().unwrap().sequence, 2);
    }

    #[test]
    fn slow_subscriber_observes_bounded_lag() {
        let bus = EventBus::new();
        let mut receiver = bus.subscribe();
        for _ in 0..(EVENT_CAPACITY + 1) {
            bus.publish(DomainEventKind::CoreStarted);
        }
        assert!(matches!(receiver.try_recv(), Err(TryRecvError::Lagged(skipped)) if skipped > 0));
    }

    #[test]
    fn dropping_one_subscriber_leaves_others_receiving() {
        let bus = EventBus::new();
        let dropped = bus.subscribe();
        let mut kept = bus.subscribe();
        bus.publish(DomainEventKind::CoreStarted);
        drop(dropped);
        bus.publish(DomainEventKind::CoreShuttingDown);
        assert_eq!(kept.try_recv().unwrap().sequence, 1);
        let second = kept.try_recv().unwrap();
        assert_eq!(second.sequence, 2);
        assert!(matches!(second.payload, DomainEventKind::CoreShuttingDown));
        assert!(matches!(kept.try_recv(), Err(TryRecvError::Empty)));
    }
}

#[cfg(test)]
mod active_tests {
    use super::*;

    fn reply(kind: &str, room: &str, agent: &str) -> DomainEventKind {
        let id = AgentInstanceId::new(room, agent);
        let (turn_id, room_id, agent_id) = ("t".to_owned(), room.to_owned(), agent.to_owned());
        match kind {
            "start" => DomainEventKind::AgentReplyStarted {
                turn_id,
                room_id,
                agent_id,
                agent_instance_id: id,
            },
            _ => DomainEventKind::AgentReplyCompleted {
                turn_id,
                room_id,
                agent_id,
                agent_instance_id: id,
            },
        }
    }

    #[test]
    fn active_replies_follow_start_and_finish_and_reset_per_room_turn() {
        let bus = EventBus::new();
        bus.publish(reply("start", "r", "A"));
        bus.publish(reply("start", "r", "B"));
        bus.publish(reply("start", "other", "C"));
        assert_eq!(bus.active_replies("r"), ["A", "B"]);
        bus.publish(reply("done", "r", "A"));
        assert_eq!(bus.active_replies("r"), ["B"]);
        assert_eq!(bus.active_replies("other"), ["C"]);
        // A turn that died without reporting leaves nothing behind once the room moves on.
        bus.publish(DomainEventKind::TurnStarted {
            turn_id: "t2".into(),
            room_id: "r".into(),
        });
        assert!(bus.active_replies("r").is_empty());
        assert_eq!(bus.active_replies("other"), ["C"]);
    }
}
