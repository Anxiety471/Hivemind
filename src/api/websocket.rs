use axum::extract::ws::{close_code, CloseFrame, Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::{
    collections::HashSet,
    sync::Arc,
    time::{Duration, UNIX_EPOCH},
};
use tokio::sync::{broadcast, watch};

use super::protocol::{Envelope, Outbound};
use crate::{
    core::HivemindCore,
    events::{DomainEvent, DomainEventKind},
};

pub(super) async fn handle(
    mut socket: WebSocket,
    core: Arc<HivemindCore>,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut events = core.events().subscribe();
    // `None` delivers every event; `Some` limits room-scoped events to those rooms.
    let mut rooms: Option<HashSet<String>> = None;
    if send(
        &mut socket,
        Outbound::event(
            "system.ready",
            None,
            json!({
                "service": "hivemind",
                "protocol_version": 1
            }),
        ),
    )
    .await
    .is_err()
    {
        return;
    }

    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    drain_queued(&mut socket, &mut events, &rooms).await;
                    close(&mut socket, None).await;
                    break;
                }
            }
            event = events.recv() => match event {
                Ok(event) => {
                    if send_batch(&mut socket, &mut events, &event, &rooms).await.is_err() { break; }
                }
                Err(broadcast::error::RecvError::Lagged(missed)) => {
                    let message = Outbound::event(
                        "system.events_lagged",
                        None,
                        json!({"missed_count": missed, "refresh_required": true}),
                    );
                    if send(&mut socket, message).await.is_err() { break; }
                }
                Err(broadcast::error::RecvError::Closed) => {
                    close(&mut socket, None).await;
                    break;
                }
            },
            message = socket.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let response = match serde_json::from_str::<Envelope>(text.as_str()) {
                        Ok(envelope) if envelope.r#type == "events.subscribe" => subscribe(envelope, &mut rooms),
                        Ok(envelope) => process(envelope),
                        Err(_) => Outbound::event("system.error", None, json!({
                            "code": "malformed_message",
                            "message": "invalid websocket JSON envelope"
                        }))
                    };
                    if send(&mut socket, response).await.is_err() { break; }
                }
                Some(Ok(Message::Ping(payload))) => {
                    if socket.send(Message::Pong(payload)).await.is_err() { break; }
                }
                Some(Ok(Message::Close(frame))) => {
                    close(&mut socket, frame).await;
                    break;
                }
                None | Some(Err(_)) => break,
                Some(Ok(Message::Binary(_))) => {
                    let response = Outbound::event("system.error", None, json!({
                        "code": "unsupported_message",
                        "message": "only JSON text messages are supported"
                    }));
                    if send(&mut socket, response).await.is_err() { break; }
                }
                Some(Ok(Message::Pong(_))) => {}
            }
        }
    }
}

fn map_event(event: &DomainEvent) -> Option<Outbound> {
    let (event_type, payload) = match &event.payload {
        DomainEventKind::ThreadCreated {
            thread_id,
            parent_room_id,
            anchor_message_id,
        } => (
            "thread.created",
            json!({"thread_id": thread_id, "parent_room_id": parent_room_id, "anchor_message_id": anchor_message_id}),
        ),
        DomainEventKind::TurnStarted { room_id, turn_id } => (
            "conversation.turn.started",
            json!({"room_id": room_id, "turn_id": turn_id}),
        ),
        DomainEventKind::TurnCompleted {
            room_id,
            turn_id,
            reply_count,
            ..
        } => (
            "conversation.turn.completed",
            json!({"room_id": room_id, "turn_id": turn_id, "reply_count": reply_count}),
        ),
        DomainEventKind::AgentReplyStarted {
            room_id,
            turn_id,
            agent_instance_id,
            ..
        } => (
            "agent.reply.started",
            json!({"room_id": room_id, "turn_id": turn_id, "agent_instance_id": agent_instance_id.encode()}),
        ),
        DomainEventKind::AgentReplyCompleted {
            room_id,
            turn_id,
            agent_instance_id,
            ..
        } => (
            "agent.reply.completed",
            json!({"room_id": room_id, "turn_id": turn_id, "agent_instance_id": agent_instance_id.encode()}),
        ),
        DomainEventKind::AgentReplyFailed {
            room_id,
            turn_id,
            agent_instance_id,
            ..
        } => (
            "agent.reply.failed",
            json!({"room_id": room_id, "turn_id": turn_id, "agent_instance_id": agent_instance_id.encode()}),
        ),
        DomainEventKind::RuntimeStarted {
            agent_instance_id,
            runtime,
            ..
        } => (
            "runtime.started",
            json!({"agent_instance_id": agent_instance_id.encode(), "runtime": runtime}),
        ),
        DomainEventKind::RuntimeStopped {
            agent_instance_id,
            runtime,
            reason,
            ..
        } => (
            "runtime.stopped",
            json!({"agent_instance_id": agent_instance_id.encode(), "runtime": runtime, "reason": reason}),
        ),
        DomainEventKind::RuntimeFailed {
            agent_instance_id,
            runtime,
            error_code,
            ..
        } => (
            "runtime.failed",
            json!({"agent_instance_id": agent_instance_id.encode(), "runtime": runtime, "error_code": error_code}),
        ),
        DomainEventKind::RuntimeRotated {
            agent_instance_id,
            runtime,
            reason,
            ..
        } => (
            "runtime.rotated",
            json!({"agent_instance_id": agent_instance_id.encode(), "runtime": runtime, "reason": reason}),
        ),
        DomainEventKind::Coordination {
            seq,
            root_id,
            task_id,
            event_type,
            actor,
            payload,
        } => (
            crate::coordination::wire_type(event_type),
            json!({"durable_seq": seq, "root_id": root_id, "task_id": task_id, "actor": actor, "data": payload}),
        ),
        DomainEventKind::CoreStarted | DomainEventKind::CoreShuttingDown => return None,
    };
    let occurred_at_ms = event
        .occurred_at
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut public_payload = payload;
    public_payload["event_id"] = json!(event.event_id);
    public_payload["sequence"] = json!(event.sequence);
    public_payload["occurred_at_ms"] = json!(occurred_at_ms);
    public_payload["event_version"] = json!(1);
    Some(Outbound::event(event_type, None, public_payload))
}
/// `{"room_ids": [...]}` limits room-scoped events (conversation, replies, threads) to those
/// rooms; an empty or missing list restores the full stream. Runtime and coordination events
/// are not room-scoped and always arrive.
fn subscribe(envelope: Envelope, rooms: &mut Option<HashSet<String>>) -> Outbound {
    let ids: Option<Vec<String>> = match envelope.payload.get("room_ids") {
        None | Some(serde_json::Value::Null) => Some(Vec::new()),
        Some(value) => serde_json::from_value(value.clone()).ok(),
    };
    let Some(ids) = ids.filter(|ids| ids.len() <= 256) else {
        return Outbound::event(
            "system.error",
            envelope.id,
            json!({"code": "invalid_subscription", "message": "room_ids must be a list of at most 256 strings"}),
        );
    };
    *rooms = (!ids.is_empty()).then(|| ids.iter().cloned().collect());
    Outbound::event("events.subscribed", envelope.id, json!({"room_ids": ids}))
}

/// The room a conversation-level event belongs to; `None` for events that are not room-scoped.
fn event_room(event: &DomainEvent) -> Option<&str> {
    match &event.payload {
        DomainEventKind::ThreadCreated { parent_room_id, .. } => Some(parent_room_id),
        DomainEventKind::TurnStarted { room_id, .. }
        | DomainEventKind::TurnCompleted { room_id, .. }
        | DomainEventKind::AgentReplyStarted { room_id, .. }
        | DomainEventKind::AgentReplyCompleted { room_id, .. }
        | DomainEventKind::AgentReplyFailed { room_id, .. } => Some(room_id),
        _ => None,
    }
}

fn wanted(event: &DomainEvent, rooms: &Option<HashSet<String>>) -> bool {
    match (rooms, event_room(event)) {
        (Some(rooms), Some(room)) => {
            rooms.contains(room)
                || matches!(&event.payload, DomainEventKind::ThreadCreated { thread_id, .. } if rooms.contains(thread_id))
        }
        _ => true,
    }
}

fn process(envelope: Envelope) -> Outbound {
    let _payload = envelope.payload;
    match envelope.r#type.as_str() {
        "system.ping" => Outbound::event("system.pong", envelope.id, json!({})),
        _ => {
            eprintln!("WebSocket protocol error: unsupported message type");
            Outbound::event(
                "system.error",
                envelope.id,
                json!({
                    "code": "unsupported_message",
                    "message": "unsupported websocket message type"
                }),
            )
        }
    }
}

fn encode(message: &Outbound) -> String {
    serde_json::to_string(message).unwrap_or_else(|_| {
        r#"{"type":"system.error","payload":{"code":"serialization_error","message":"failed to encode message"}}"#.to_owned()
    })
}

async fn send(socket: &mut WebSocket, message: Outbound) -> Result<(), axum::Error> {
    socket.send(Message::Text(encode(&message).into())).await
}

fn lagged(missed: u64) -> Outbound {
    Outbound::event(
        "system.events_lagged",
        None,
        json!({"missed_count": missed, "refresh_required": true}),
    )
}

/// Queue `event` without flushing; events with no public frame queue nothing.
async fn feed_event(
    socket: &mut WebSocket,
    event: &DomainEvent,
    rooms: &Option<HashSet<String>>,
) -> Result<(), axum::Error> {
    if !wanted(event, rooms) {
        return Ok(());
    }
    match event.frame_with(|event| map_event(event).map(|message| encode(&message))) {
        Some(text) => socket.feed(Message::Text(text.into())).await,
        None => Ok(()),
    }
}

/// Send `first` plus every event that arrives within a millisecond with one
/// flush, so a burst of lifecycle events costs one loopback write instead of
/// one each. Notifications tolerate the delay; model latency dwarfs it.
async fn send_batch(
    socket: &mut WebSocket,
    events: &mut broadcast::Receiver<Arc<DomainEvent>>,
    first: &DomainEvent,
    rooms: &Option<HashSet<String>>,
) -> Result<(), axum::Error> {
    const MAX_BATCH: usize = 32;
    feed_event(socket, first, rooms).await?;
    tokio::time::sleep(Duration::from_millis(1)).await;
    for _ in 0..MAX_BATCH {
        match events.try_recv() {
            Ok(event) => feed_event(socket, &event, rooms).await?,
            Err(broadcast::error::TryRecvError::Lagged(missed)) => {
                socket
                    .feed(Message::Text(encode(&lagged(missed)).into()))
                    .await?
            }
            Err(_) => break,
        }
    }
    socket.flush().await
}

/// Domain events are encoded once and the same frame text is reused for every client.
async fn send_event(
    socket: &mut WebSocket,
    event: &DomainEvent,
    rooms: &Option<HashSet<String>>,
) -> Result<(), axum::Error> {
    if !wanted(event, rooms) {
        return Ok(());
    }
    match event.frame_with(|event| map_event(event).map(|message| encode(&message))) {
        Some(text) => socket.send(Message::Text(text.into())).await,
        None => Ok(()),
    }
}

/// Frames already queued for this client are flushed before the close so
/// shutdown lifecycle events are not lost. Bounded by frame count and time;
/// nothing is replayed or buffered beyond what the receiver already holds.
async fn drain_queued(
    socket: &mut WebSocket,
    events: &mut broadcast::Receiver<Arc<DomainEvent>>,
    rooms: &Option<HashSet<String>>,
) {
    const MAX_FRAMES: usize = 64;
    let flush = async {
        for _ in 0..MAX_FRAMES {
            match events.try_recv() {
                Ok(event) => {
                    if send_event(socket, &event, rooms).await.is_err() {
                        return;
                    }
                }
                Err(broadcast::error::TryRecvError::Lagged(missed)) => {
                    let message = Outbound::event(
                        "system.events_lagged",
                        None,
                        json!({"missed_count": missed, "refresh_required": true}),
                    );
                    if send(socket, message).await.is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(1), flush).await;
}
async fn close(socket: &mut WebSocket, frame: Option<CloseFrame>) {
    let frame = frame.or_else(|| {
        Some(CloseFrame {
            code: close_code::NORMAL,
            reason: "server shutdown".into(),
        })
    });
    if socket.send(Message::Close(frame)).await.is_ok() {
        let _ = tokio::time::timeout(Duration::from_secs(1), socket.next()).await;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::AgentInstanceId;

    fn event(payload: DomainEventKind) -> DomainEvent {
        DomainEvent::new(
            "test-event".into(),
            1,
            std::time::SystemTime::now(),
            payload,
        )
    }

    #[test]
    fn runtime_lifecycle_reasons_are_public_but_provider_errors_are_not() {
        let instance = AgentInstanceId::new("room", "persona");
        let failed = event(DomainEventKind::RuntimeFailed {
            agent_id: "persona".into(),
            agent_instance_id: instance.clone(),
            runtime: "pi".into(),
            error_code: "prompt_timeout".into(),
            message: "sensitive provider diagnostic".into(),
        });
        let failed = map_event(&failed).unwrap();
        assert_eq!(failed.payload["error_code"], "prompt_timeout");
        assert!(!serde_json::to_string(&failed)
            .unwrap()
            .contains("sensitive provider diagnostic"));

        let stopped = event(DomainEventKind::RuntimeStopped {
            agent_id: "persona".into(),
            agent_instance_id: instance,
            runtime: "pi".into(),
            reason: "core_shutdown".into(),
        });
        let stopped = map_event(&stopped).unwrap();
        assert_eq!(stopped.payload["reason"], "core_shutdown");
    }

    #[test]
    fn websocket_encodes_and_round_trips_agent_instance_identity() {
        let identities = [
            AgentInstanceId::new("a/b", "c"),
            AgentInstanceId::new("a", "b/c"),
            AgentInstanceId::new("雪 / room", "persona:# ☕"),
        ];
        let mut encoded = Vec::new();

        for identity in &identities {
            let mapped = map_event(&event(DomainEventKind::AgentReplyCompleted {
                room_id: identity.room_id.clone(),
                turn_id: "turn".into(),
                agent_id: identity.persona_id.clone(),
                agent_instance_id: identity.clone(),
            }))
            .unwrap();
            let value = mapped.payload["agent_instance_id"]
                .as_str()
                .expect("agent_instance_id is a string");
            assert_eq!(AgentInstanceId::decode(value), Some(identity.clone()));
            encoded.push(value.to_owned());
        }

        assert_ne!(encoded[0], encoded[1]);
    }

    #[test]
    fn coordination_events_keep_their_type_and_durable_sequence() {
        let mapped = map_event(&event(DomainEventKind::Coordination {
            seq: 42,
            root_id: "tk_root".into(),
            task_id: Some("tk_child".into()),
            event_type: "task.status_changed".into(),
            actor: "hivemind".into(),
            payload: json!({"to": "running"}),
        }))
        .unwrap();
        assert_eq!(mapped.r#type, "task.status_changed");
        assert_eq!(mapped.payload["durable_seq"], 42);
        assert_eq!(mapped.payload["data"]["to"], "running");
        assert_eq!(
            mapped.payload["sequence"], 1,
            "process-local bus sequence stays separate"
        );
        let unknown = map_event(&event(DomainEventKind::Coordination {
            seq: 1,
            root_id: "r".into(),
            task_id: None,
            event_type: "future.kind".into(),
            actor: "a".into(),
            payload: json!({}),
        }))
        .unwrap();
        assert_eq!(unknown.r#type, "coordination.event");
    }
}
