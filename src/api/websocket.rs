use axum::extract::ws::{close_code, CloseFrame, Message, WebSocket};
use futures_util::StreamExt;
use serde_json::json;
use std::time::Duration;
use tokio::sync::watch;

use super::protocol::{Envelope, Outbound};

pub(super) async fn handle(mut socket: WebSocket, mut shutdown: watch::Receiver<bool>) {
    println!("WebSocket client connected");
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
        println!("WebSocket client disconnected during handshake");
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
            message = socket.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let response = match serde_json::from_str::<Envelope>(text.as_str()) {
                        Ok(envelope) => process(envelope),
                        Err(_) => {
                            eprintln!("WebSocket protocol error: malformed JSON envelope");
                            Outbound::event("system.error", None, json!({
                                "code": "malformed_message",
                                "message": "invalid websocket JSON envelope"
                            }))
                        }
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
                    eprintln!("WebSocket protocol error: unsupported binary message");
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
    println!("WebSocket client disconnected");
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
