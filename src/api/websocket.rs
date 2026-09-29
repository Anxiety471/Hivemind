use axum::extract::ws::{close_code, CloseFrame, Message, WebSocket};
use futures_util::StreamExt;
use serde_json::json;
use std::{
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
                    close(&mut socket, None).await;
                    break;
                }
            }
            event = events.recv() => match event {
                Ok(event) => {
                    if let Some(message) = map_event(&event) {
                        if send(&mut socket, message).await.is_err() { break; }
                    }
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

async fn send(socket: &mut WebSocket, message: Outbound) -> Result<(), axum::Error> {
    let text = serde_json::to_string(&message).unwrap_or_else(|_| {
        r#"{"type":"system.error","payload":{"code":"serialization_error","message":"failed to encode message"}}"#.to_owned()
    });
    socket.send(Message::Text(text.into())).await
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
        DomainEvent {
            event_id: "test-event".into(),
            sequence: 1,
            occurred_at: std::time::SystemTime::now(),
            payload,
        }
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
}
