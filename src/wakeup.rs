//! Chat wakeups: an agent scheduling its own future re-entry into a chat room.
//!
//! In a task room a self-wakeup is a durable self-addressed message that the
//! coordination scheduler claims when due. A chat room has no task, so a wakeup
//! there is stored in `chat_wakeups` and delivered through the durable turn
//! queue: the worker submits the composed body as a turn in the same room,
//! where it runs as a user-style message. [`ChatWakeupTools`] owns the
//! `wakeup.schedule` name in every room and delegates task rooms to
//! [`CoordinationService::schedule_wakeup_from_room`], so the tool surface and
//! its bounds stay identical wherever an agent calls it.
use std::sync::Arc;

use anyhow::{bail, Result};
use serde_json::{json, Value};

use crate::{
    conversation::ToolHost,
    coordination::{
        model::{check_text, new_id, task_of_room, CoordError, CoordResult},
        service::CoordinationService,
    },
    core::{parent_target, ConversationTarget},
    execution::ExecutionStore,
};

/// Shortest delay a wakeup may use, in seconds.
pub const MIN_WAKEUP_DELAY_SECS: i64 = 1;
/// Longest delay a wakeup may use, in seconds (one week).
pub const MAX_WAKEUP_DELAY_SECS: i64 = 7 * 24 * 3600;
/// Per-field byte bound on a wakeup's `intent`, `reminder`, or `note`.
pub const MAX_WAKEUP_TEXT: usize = 2000;
/// How many chat wakeups may be outstanding in one room.
pub const MAX_PENDING_CHAT_WAKEUPS: i64 = 5;
/// How often a chat wakeup left `dispatched` by a crash may be redelivered
/// after a restart before it is dropped, so a stuck row never loops forever.
pub const MAX_CHAT_WAKEUP_ATTEMPTS: i64 = 3;

/// Composes the labeled body a wakeup carries, omitting absent purposes.
pub fn compose_body(intent: Option<&str>, reminder: Option<&str>, note: Option<&str>) -> String {
    [
        intent.map(|v| format!("Intent: {v}")),
        reminder.map(|v| format!("Reminder: {v}")),
        note.map(|v| format!("Note: {v}")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n")
}

/// Validates a wakeup's delay and purposes, then composes the delivered body:
/// the delay must be within [`MIN_WAKEUP_DELAY_SECS`]..=[`MAX_WAKEUP_DELAY_SECS`],
/// each stated purpose is bounded by [`MAX_WAKEUP_TEXT`], and at least one
/// purpose is required.
pub fn validate_and_compose(
    delay_secs: i64,
    intent: Option<&str>,
    reminder: Option<&str>,
    note: Option<&str>,
) -> CoordResult<String> {
    if !(MIN_WAKEUP_DELAY_SECS..=MAX_WAKEUP_DELAY_SECS).contains(&delay_secs) {
        return Err(CoordError::Invalid(format!(
            "delay_seconds must be between {MIN_WAKEUP_DELAY_SECS} and {MAX_WAKEUP_DELAY_SECS}"
        )));
    }
    // Each field is bounded on its own, even when another is present.
    let intent = intent
        .map(|v| check_text("wakeup intent", v, MAX_WAKEUP_TEXT))
        .transpose()?;
    let reminder = reminder
        .map(|v| check_text("wakeup reminder", v, MAX_WAKEUP_TEXT))
        .transpose()?;
    let note = note
        .map(|v| check_text("wakeup note", v, MAX_WAKEUP_TEXT))
        .transpose()?;
    if intent.is_none() && reminder.is_none() && note.is_none() {
        return Err(CoordError::Invalid(
            "a wakeup needs at least one of 'intent' (what to do), 'reminder' (what to act on), or 'note' (state to carry)".into(),
        ));
    }
    Ok(compose_body(
        intent.as_deref(),
        reminder.as_deref(),
        note.as_deref(),
    ))
}

/// The turn-job target that re-enters `room`, in the shape the jobs worker
/// accepts. `None` for a thread or any room that is not a chat room.
pub fn chat_target(room: &str) -> Option<Value> {
    Some(match parent_target(room)? {
        ConversationTarget::Main => json!({"type": "main"}),
        ConversationTarget::Solo { persona_id } => json!({"type": "solo", "id": persona_id}),
        ConversationTarget::Group { group_id } => json!({"type": "group", "id": group_id}),
        // Threads have no wakeup target: `parent_target` already rejects them.
        ConversationTarget::Thread { .. } => return None,
    })
}

/// The body actually delivered on wakeup: a marker line so the future self
/// knows the message is its own schedule and not something a user typed,
/// followed by the composed purposes.
pub fn delivered_message(id: &str, body: &str) -> String {
    format!("{MARKER_PREFIX}{id}: you scheduled this; it is not a user message]\n{body}")
}

const MARKER_PREFIX: &str = "[Hivemind wakeup ";

/// Whether `text` is a wakeup body Hivemind delivered (see
/// [`delivered_message`]). Used to keep the agent's own scheduled words from
/// being read as user directives.
pub fn is_wakeup_message(text: &str) -> bool {
    text.starts_with(MARKER_PREFIX)
}

fn opt_str(args: &Value, key: &str) -> Result<Option<String>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(Some(s.trim().to_owned())),
        Some(_) => bail!("argument '{key}' must be a non-empty string"),
    }
}

/// Host-bound `wakeup.schedule` for chat rooms, with task rooms delegated to
/// coordination. Must be registered before `CoordinationTools` in the host
/// list so it wins the shared tool name.
pub struct ChatWakeupTools {
    service: Arc<CoordinationService>,
    execution: Arc<ExecutionStore>,
}

impl ChatWakeupTools {
    pub fn new(service: Arc<CoordinationService>, execution: Arc<ExecutionStore>) -> Self {
        Self { service, execution }
    }

    /// Whether `room` is a chat room a wakeup can re-enter: any parent room,
    /// but never a task room (coordination owns the tool there).
    fn is_chat_room(room: &str) -> bool {
        task_of_room(room).is_none() && parent_target(room).is_some()
    }
}

fn manifest() -> String {
    format!(
        "Hivemind wakeup tool (same ```hivemind-tool fence as memory tools; one call per reply as your whole reply):\nExample:\n{{\"name\":\"wakeup.schedule\",\"args\":{{\"delay_seconds\":600,\"intent\":\"re-check the answer\",\"reminder\":\"only if it is still open\",\"note\":\"thread is mg_...\"}}}}\nRules: a wakeup re-enters this room later as a user message carrying your intent/reminder/note, so you can continue on your own schedule; give at least one of intent, reminder, or note, and delay_seconds between {MIN_WAKEUP_DELAY_SECS} and {MAX_WAKEUP_DELAY_SECS}. It is the only wake you can author: you cannot list or cancel one, and at most {MAX_PENDING_CHAT_WAKEUPS} may be pending per room.\n"
    )
}

impl ToolHost for ChatWakeupTools {
    fn manifest(&self, room: &str, _persona: &str) -> Option<String> {
        Self::is_chat_room(room).then(manifest)
    }

    fn handles(&self, name: &str) -> bool {
        name == "wakeup.schedule"
    }

    fn execute(&self, room: &str, persona: &str, name: &str, args: &Value) -> Result<String> {
        if name != "wakeup.schedule" {
            bail!("unknown wakeup tool '{name}'");
        }
        let delay = args
            .get("delay_seconds")
            .and_then(Value::as_i64)
            .ok_or_else(|| anyhow::anyhow!("argument 'delay_seconds' must be an integer"))?;
        let intent = opt_str(args, "intent")?;
        let reminder = opt_str(args, "reminder")?;
        let note = opt_str(args, "note")?;
        let key = opt_str(args, "key")?;
        // Task rooms keep today's behavior exactly: the wakeup rides the
        // coordination message queue and is bound to the live attempt.
        if task_of_room(room).is_some() {
            let (message, duplicate) = self
                .service
                .schedule_wakeup_from_room(
                    room,
                    persona,
                    delay,
                    intent.as_deref(),
                    reminder.as_deref(),
                    note.as_deref(),
                    key.as_deref(),
                )
                .map_err(|error| anyhow::anyhow!("{error}"))?;
            return Ok(format!(
                "{} wakeup {}: Hivemind will wake you once, in {delay}s, with this intent/reminder/note",
                if duplicate { "already scheduled" } else { "scheduled" },
                message.id
            ));
        }
        let target = chat_target(room)
            .ok_or_else(|| anyhow::anyhow!("wakeups are not supported in threads"))?;
        let body = validate_and_compose(
            delay,
            intent.as_deref(),
            reminder.as_deref(),
            note.as_deref(),
        )
        .map_err(|error| anyhow::anyhow!("{error}"))?;
        let id = new_id("wk");
        let message = delivered_message(&id, &body);
        let stored = self.execution.insert_chat_wakeup(
            &id,
            room,
            &target,
            &message,
            crate::execution::now() + delay,
            MAX_PENDING_CHAT_WAKEUPS,
            key.as_deref(),
        )?;
        Ok(format!(
            "{} wakeup {}: Hivemind will re-enter this room once, in {delay}s, with this intent/reminder/note",
            if stored.deduped { "already scheduled" } else { "scheduled" },
            stored.id
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_targets_cover_chat_rooms_and_reject_threads_and_tasks() {
        assert_eq!(chat_target("main").unwrap(), json!({"type":"main"}));
        assert_eq!(
            chat_target("solo-Lead").unwrap(),
            json!({"type":"solo","id":"Lead"})
        );
        assert_eq!(
            chat_target("group-orders").unwrap(),
            json!({"type":"group","id":"orders"})
        );
        assert!(chat_target("thread-t1").is_none());
        assert!(chat_target("task-tk_1").is_none());
    }

    #[test]
    fn delivered_bodies_announce_themselves_and_label_purposes() {
        let body = validate_and_compose(
            600,
            Some("resume the API work"),
            None,
            Some("branch api/fix"),
        )
        .unwrap();
        assert_eq!(body, "Intent: resume the API work\nNote: branch api/fix");
        let message = delivered_message("wk_1", &body);
        assert!(message
            .starts_with("[Hivemind wakeup wk_1: you scheduled this; it is not a user message]\n"));
        assert!(message.ends_with(&body));
    }

    #[test]
    fn compose_body_omits_absent_purposes() {
        assert_eq!(compose_body(Some("a"), None, None), "Intent: a");
        assert_eq!(compose_body(None, Some("b"), None), "Reminder: b");
        assert_eq!(compose_body(None, None, Some("c")), "Note: c");
        assert_eq!(
            compose_body(Some("a"), Some("b"), Some("c")),
            "Intent: a\nReminder: b\nNote: c"
        );
    }

    fn hosts() -> (crate::shared_workspace::ToolHosts, Arc<ExecutionStore>) {
        use crate::{
            access::Audit,
            config::HivemindConfig,
            coordination::{
                policy::Roster, service::CoordinationService, store::CoordinationStore,
                tools::CoordinationTools,
            },
            events::EventBus,
        };
        let mut config = HivemindConfig::default_poc();
        config.coordination.enabled = true;
        let service = Arc::new(CoordinationService::new(
            CoordinationStore::in_memory().unwrap(),
            config.coordination.clone(),
            Roster::from_config(&config),
            EventBus::new(),
        ));
        let execution = Arc::new(ExecutionStore::open(":memory:", Default::default()).unwrap());
        service.set_execution(execution.clone());
        let audit = Arc::new(Audit::in_memory().unwrap());
        let hosts = crate::shared_workspace::ToolHosts(vec![
            Arc::new(ChatWakeupTools::new(service.clone(), execution.clone())),
            Arc::new(CoordinationTools::new(service, audit)),
        ]);
        (hosts, execution)
    }

    #[test]
    fn chat_host_owns_the_name_in_chat_rooms_and_stores_a_wakeup() {
        let (hosts, execution) = hosts();
        assert!(hosts.handles("wakeup.schedule"));
        for room in ["main", "solo-Lead", "group-team"] {
            let manifest = hosts.manifest(room, "Lead").expect(room);
            assert!(manifest.contains("wakeup.schedule"), "{room}: {manifest}");
        }
        // A thread has no wakeup target: no manifest, and a call is refused.
        assert!(hosts.manifest("thread-t1", "Lead").is_none());
        assert!(hosts
            .execute(
                "thread-t1",
                "Lead",
                "wakeup.schedule",
                &json!({"delay_seconds": 60, "intent": "x"})
            )
            .is_err());
        // No purpose at all is rejected before anything is stored.
        assert!(hosts
            .execute(
                "solo-Lead",
                "Lead",
                "wakeup.schedule",
                &json!({"delay_seconds": 60})
            )
            .is_err());
        assert_eq!(
            execution.pending_chat_wakeups("solo-Lead", None).unwrap(),
            0
        );
        // A valid call stores one wakeup for this persona in this room.
        let reply = hosts
            .execute(
                "solo-Lead",
                "Lead",
                "wakeup.schedule",
                &json!({"delay_seconds": 60, "intent": "check the API", "note": "branch api/fix"}),
            )
            .unwrap();
        assert!(reply.contains("will re-enter this room"), "{reply}");
        assert_eq!(
            execution
                .pending_chat_wakeups("solo-Lead", Some("Lead"))
                .unwrap(),
            1
        );
        assert_eq!(
            execution
                .pending_chat_wakeups("solo-Lead", Some("Other"))
                .unwrap(),
            0
        );
        // Still in the future, so nothing is handed to the turn queue yet.
        assert!(execution.due_chat_wakeups(10).unwrap().is_empty());
    }

    #[test]
    fn task_rooms_delegate_to_coordination() {
        let (hosts, _execution) = hosts();
        // The registered order puts the chat host first so it owns the name;
        // it stays silent in task rooms, while coordination no longer claims
        // the name at all (it only advertises it from its own manifest).
        assert!(hosts.0[0].handles("wakeup.schedule"));
        assert!(hosts.0[0].manifest("task-tk_1", "Lead").is_none());
        assert!(!hosts.0[1].handles("wakeup.schedule"));
        // Without a live attempt the delegation path reports exactly that.
        let error = hosts
            .execute(
                "task-tk_1",
                "Lead",
                "wakeup.schedule",
                &json!({"delay_seconds": 60, "intent": "check"}),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("no live task attempt"), "{error}");
    }
}
