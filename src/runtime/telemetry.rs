//! Adapter-neutral progress. Only assistant text and tool identity/status are
//! public; reasoning, tool arguments, outputs, and provider errors are excluded.
use crate::{
    events::{DomainEventKind, EventBus},
    execution::Usage,
    identity::AgentInstanceId,
};
use serde_json::Value;
use std::sync::Arc;
#[derive(Clone)]
pub struct ProgressSink {
    pub events: EventBus,
    pub instance: AgentInstanceId,
    pub turn_id: String,
    pub activity: Option<Arc<tokio::sync::Notify>>,
}
impl ProgressSink {
    pub fn touch(&self) {
        if let Some(activity) = &self.activity {
            activity.notify_one();
        }
    }

    pub fn emit(&self, kind: &str, message_id: &str, text: &str) {
        self.touch();
        // Split oversized chunks at UTF-8 boundaries without silently losing text.
        let mut remaining = text;
        loop {
            let mut end = remaining.len().min(8192);
            while !remaining.is_char_boundary(end) {
                end -= 1;
            }
            self.events.publish(DomainEventKind::RuntimeProgress {
                room_id: self.instance.room_id.clone(),
                turn_id: self.turn_id.clone(),
                agent_instance_id: self.instance.clone(),
                kind: kind.into(),
                message_id: message_id.chars().take(200).collect(),
                text: remaining[..end].into(),
            });
            remaining = &remaining[end..];
            if remaining.is_empty() {
                break;
            }
        }
    }

    pub fn rpc(&self, frame: &Value) {
        self.touch();
        match frame["type"].as_str() {
            Some("message_update") => {
                let event = &frame["assistantMessageEvent"];
                if event["type"] == "text_delta" {
                    if let Some(text) = event["delta"].as_str() {
                        self.emit("text", "", text);
                    }
                }
            }
            Some("tool_execution_start") => self.emit(
                "tool_started",
                frame["toolCallId"].as_str().unwrap_or(""),
                frame["toolName"].as_str().unwrap_or("tool"),
            ),
            Some("tool_execution_end") => self.emit(
                "tool_finished",
                frame["toolCallId"].as_str().unwrap_or(""),
                if frame["isError"] == true {
                    "failed"
                } else {
                    "completed"
                },
            ),
            _ => {}
        }
    }
    pub fn acp(&self, update: &Value) {
        self.touch();
        match update["sessionUpdate"].as_str() {
            Some("agent_message_chunk") => {
                if let Some(text) = update.pointer("/content/text").and_then(Value::as_str) {
                    self.emit("text", update["messageId"].as_str().unwrap_or(""), text);
                }
            }
            Some("tool_call") => self.emit(
                "tool_started",
                update["toolCallId"].as_str().unwrap_or(""),
                update["kind"].as_str().unwrap_or("tool"),
            ),
            Some("tool_call_update") => self.emit(
                "tool_status",
                update["toolCallId"].as_str().unwrap_or(""),
                update["status"].as_str().unwrap_or("updated"),
            ),
            _ => {}
        }
    }
}
/// Pi/OMP report per-assistant-message billing usage. Missing fields stay unknown,
/// and context occupancy (`usage_update.used`) is never treated as billed tokens.
pub fn rpc_usage(frame: &Value) -> Option<Usage> {
    if frame["type"] != "message_end" || frame["message"]["role"] != "assistant" {
        return None;
    }
    let u = &frame["message"]["usage"];
    Some(Usage {
        input_tokens: u["input"].as_u64()?,
        output_tokens: u["output"].as_u64()?,
        cache_read_tokens: u["cacheRead"].as_u64().unwrap_or(0),
        cache_write_tokens: u["cacheWrite"].as_u64().unwrap_or(0),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn ignores_reasoning_and_tool_contents() {
        let events = EventBus::new();
        let mut rx = events.subscribe();
        let sink = ProgressSink {
            events,
            instance: AgentInstanceId::new("main", "A"),
            turn_id: "t".into(),
            activity: None,
        };
        assert!(rx.try_recv().is_err());
        sink.rpc(
            &json!({"type":"tool_execution_start","toolName":"bash","args":{"secret":"private"}}),
        );
        let encoded = serde_json::to_string(rx.try_recv().unwrap().as_ref()).unwrap();
        assert!(encoded.contains("bash"));
        assert!(!encoded.contains("private"));
    }
    #[test]
    fn usage_is_measured_and_context_is_not_billing() {
        assert!(rpc_usage(&json!({"type":"usage_update","used":123})).is_none());
        assert_eq!(rpc_usage(&json!({"type":"message_end","message":{"role":"assistant","usage":{"input":5,"output":2,"cacheRead":3,"cacheWrite":1}}})).unwrap().total(),11);
    }
}
