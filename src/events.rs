//! Ephemeral process-local domain notifications. Events are not canonical state or history.
use std::sync::{Arc, Mutex};
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DomainEventKind {
    CoreStarted,
    CoreShuttingDown,
    TurnStarted { turn_id: String, room_id: String },
    TurnCompleted { turn_id: String, room_id: String, reply_count: usize },
    AgentReplyStarted { turn_id: String, room_id: String, agent_id: String, instance_id: String },
    AgentReplyCompleted { turn_id: String, room_id: String, agent_id: String, instance_id: String },
    AgentReplyFailed { turn_id: String, room_id: String, agent_id: String, instance_id: String, error_code: String, message: String },
    RuntimeStarted { agent_id: String, instance_id: String, runtime: String },
    RuntimeStopped { agent_id: String, instance_id: String, runtime: String },
    RuntimeFailed { agent_id: String, instance_id: String, runtime: String, error_code: String, message: String },
    RuntimeRotated { agent_id: String, instance_id: String, runtime: String, reason: String },
}

#[derive(Clone)]
pub struct EventBus {
    sender: broadcast::Sender<DomainEvent>,
    sequence: Arc<Mutex<u64>>,
}

impl Default for EventBus {
    fn default() -> Self { Self::new() }
}

impl EventBus {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(EVENT_CAPACITY);
        Self { sender, sequence: Arc::new(Mutex::new(0)) }
    }

    /// Each subscriber receives an independent bounded stream. Slow consumers must handle `RecvError::Lagged`.
    pub fn subscribe(&self) -> broadcast::Receiver<DomainEvent> { self.sender.subscribe() }

    /// Publish without waiting; events may be dropped for lagging subscribers.
    pub fn publish(&self, payload: DomainEventKind) {
        let mut next = self.sequence.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *next += 1;
        let sequence = *next;
        let event = DomainEvent {
            event_id: format!("evt-{sequence}"),
            sequence,
            occurred_at: SystemTime::now(),
            payload,
        };
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
