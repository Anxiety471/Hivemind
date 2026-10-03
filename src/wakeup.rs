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
/// Byte bound on a schedule's `label`, the short name shown to the user.
pub const MAX_WAKEUP_LABEL: usize = 80;
/// How many times a bounded recurring wakeup may fire.
pub const MAX_REPEAT_COUNT: i64 = 1000;
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

/// Validates a schedule's recurrence: `repeat_seconds` must be within
/// [`MIN_WAKEUP_DELAY_SECS`]..=[`MAX_WAKEUP_DELAY_SECS`] and `repeat_count`
/// within `1..=`[`MAX_REPEAT_COUNT`], and a count without an interval is
/// rejected because there is no period to repeat on.
pub fn validate_repeat(repeat_seconds: Option<i64>, repeat_count: Option<i64>) -> CoordResult<()> {
    if let Some(seconds) = repeat_seconds {
        if !(MIN_WAKEUP_DELAY_SECS..=MAX_WAKEUP_DELAY_SECS).contains(&seconds) {
            return Err(CoordError::Invalid(format!(
                "repeat_seconds must be between {MIN_WAKEUP_DELAY_SECS} and {MAX_WAKEUP_DELAY_SECS}"
            )));
        }
    }
    if let Some(count) = repeat_count {
        if repeat_seconds.is_none() {
            return Err(CoordError::Invalid(
                "repeat_count needs 'repeat_seconds': there is no period to repeat on".into(),
            ));
        }
        if !(1..=MAX_REPEAT_COUNT).contains(&count) {
            return Err(CoordError::Invalid(format!(
                "repeat_count must be between 1 and {MAX_REPEAT_COUNT}"
            )));
        }
    }
    Ok(())
}

/// Whether a recurring schedule fires again after `fires` deliveries: it must
/// have an interval, and either be unbounded or still short of its count.
pub fn repeats_after(repeat_seconds: Option<i64>, repeat_count: Option<i64>, fires: i64) -> bool {
    repeat_seconds.is_some() && repeat_count.is_none_or(|count| fires + 1 < count)
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

/// Extracts the optional `Intent: ...` line from a wakeup body.
pub fn extract_intent(body: &str) -> Option<String> {
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("Intent:") {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_owned());
            }
        }
    }
    None
}

fn opt_str(args: &Value, key: &str) -> Result<Option<String>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(Some(s.trim().to_owned())),
        Some(_) => bail!("argument '{key}' must be a non-empty string"),
    }
}

/// Reads an optional integer argument, refusing a non-integer one outright so
/// a typo never silently becomes "absent".
fn opt_int(args: &Value, key: &str) -> Result<Option<i64>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| anyhow::anyhow!("argument '{key}' must be an integer")),
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
        "Hivemind wakeup tool (same ```hivemind-tool fence as memory tools; one call per reply as your whole reply):\nExample:\n{{\"name\":\"wakeup.schedule\",\"args\":{{\"delay_seconds\":600,\"intent\":\"re-check the answer\",\"reminder\":\"only if it is still open\",\"note\":\"thread is mg_...\"}}}}\nRules: a wakeup re-enters this room later as a user message carrying your intent/reminder/note, so you can continue on your own schedule; give at least one of intent, reminder, or note, and delay_seconds between {MIN_WAKEUP_DELAY_SECS} and {MAX_WAKEUP_DELAY_SECS}. Add repeat_seconds (also up to {MAX_WAKEUP_DELAY_SECS}) to fire again every interval, optionally bounded by repeat_count (1..={MAX_REPEAT_COUNT}); without repeat_count it repeats until cancelled. label is a short name for the schedule, which the user can list and cancel for this room. It is the only wake you can author, and at most {MAX_PENDING_CHAT_WAKEUPS} may be pending per room.\n"
    )
}

impl ToolHost for ChatWakeupTools {
    fn manifest(&self, room: &str, _persona: &str) -> Option<String> {
        Self::is_chat_room(room).then(manifest)
    }

    /// Keeps the tool visible on later turns too: a chat agent that forgets
    /// `wakeup.schedule` exists cannot continue on its own schedule.
    fn reminder(&self, room: &str, _persona: &str) -> Option<String> {
        Self::is_chat_room(room).then(|| {
            format!(
                "Hivemind wakeup tool remains available: call wakeup.schedule (```hivemind-tool fence) to re-enter this room later, with delay_seconds (1-{MAX_WAKEUP_DELAY_SECS}), an optional repeat_seconds/repeat_count, a label, and at least one of intent/reminder/note.\n"
            )
        })
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
        let repeats = opt_int(args, "repeat_seconds")?;
        let count = opt_int(args, "repeat_count")?;
        let label = opt_str(args, "label")?
            .map(|label| check_text("wakeup label", &label, MAX_WAKEUP_LABEL))
            .transpose()
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        // Task rooms keep today's behavior exactly: the wakeup rides the
        // coordination message queue and is bound to the live attempt. A
        // recurring wakeup has no place there, but a label still names it.
        if task_of_room(room).is_some() {
            if repeats.is_some() || count.is_some() {
                let error = CoordError::Invalid(
                    "recurring wakeups are supported in chat rooms; a task-room wakeup fires once"
                        .into(),
                );
                bail!("{error}");
            }
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
                "{}{} wakeup {}: Hivemind will wake you once, in {delay}s, with this intent/reminder/note",
                if duplicate { "already scheduled" } else { "scheduled" },
                label
                    .as_deref()
                    .map(|label| format!(" '{label}'"))
                    .unwrap_or_default(),
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
        validate_repeat(repeats, count).map_err(|error| anyhow::anyhow!("{error}"))?;
        // Keys are the agent's own names, so they are scoped to this room and
        // persona: the same key in another room is a different schedule.
        let key = key
            .map(|key| {
                check_text("idempotency key", &key, 200)
                    .map(|key| format!("{room}\u{1f}{persona}\u{1f}{key}"))
            })
            .transpose()
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        let id = new_id("wk");
        // The clean body is stored; the delivery marker is added when the
        // wakeup fires, so the list endpoint shows what the agent wrote.
        let stored = self.execution.insert_chat_wakeup(
            &id,
            room,
            &target,
            &body,
            crate::execution::now() + delay,
            MAX_PENDING_CHAT_WAKEUPS,
            key.as_deref(),
            label.as_deref(),
            repeats,
            count,
        )?;
        let schedule = match (repeats, count) {
            (Some(seconds), Some(count)) => {
                format!("{count} times, first in {delay}s then every {seconds}s")
            }
            (Some(seconds), None) => {
                format!("first in {delay}s then every {seconds}s until cancelled")
            }
            _ => format!("once, in {delay}s"),
        };
        Ok(format!(
            "{}{} wakeup {}: Hivemind will re-enter this room {schedule}, with this intent/reminder/note",
            if stored.deduped {
                "already scheduled"
            } else {
                "scheduled"
            },
            label
                .as_deref()
                .map(|label| format!(" '{label}'"))
                .unwrap_or_default(),
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
    fn a_wakeup_key_is_scoped_to_its_room_and_persona() {
        let (hosts, execution) = hosts();
        let schedule = |room: &str, persona: &str| {
            hosts
                .execute(
                    room,
                    persona,
                    "wakeup.schedule",
                    &json!({"delay_seconds": 60, "intent": "check in", "key": "daily"}),
                )
                .unwrap()
        };
        assert!(schedule("main", "Lead").starts_with("scheduled"));
        assert!(schedule("main", "Lead").starts_with("already scheduled"));
        // The same key elsewhere is someone else's schedule, not a duplicate.
        assert!(schedule("solo-Lead", "Lead").starts_with("scheduled"));
        assert!(schedule("main", "Other").starts_with("scheduled"));
        assert_eq!(execution.chat_wakeups_for("main").unwrap().len(), 2);
        assert_eq!(execution.chat_wakeups_for("solo-Lead").unwrap().len(), 1);
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

    #[test]
    fn recurrence_bounds_are_enforced_without_repeat_seconds() {
        assert!(validate_repeat(Some(600), None).is_ok());
        assert!(validate_repeat(Some(60), Some(3)).is_ok());
        // The interval shares the delay bounds, at both ends.
        assert!(validate_repeat(Some(MIN_WAKEUP_DELAY_SECS), None).is_ok());
        assert!(validate_repeat(Some(MAX_WAKEUP_DELAY_SECS), None).is_ok());
        for bad in [0, -1, MAX_WAKEUP_DELAY_SECS + 1] {
            let error = validate_repeat(Some(bad), None).unwrap_err().to_string();
            assert!(error.contains("repeat_seconds must be between"), "{error}");
        }
        // A count without an interval has no period to repeat on.
        let error = validate_repeat(None, Some(2)).unwrap_err().to_string();
        assert!(
            error.contains("repeat_count needs 'repeat_seconds'"),
            "{error}"
        );
        // The count itself is bounded, and zero is not a repeat.
        for bad in [0, -3, MAX_REPEAT_COUNT + 1] {
            let error = validate_repeat(Some(60), Some(bad))
                .unwrap_err()
                .to_string();
            assert!(error.contains("repeat_count must be between"), "{error}");
        }
        assert!(validate_repeat(None, None).is_ok());
    }

    #[test]
    fn repeats_after_stops_at_the_bound_and_for_one_shots() {
        assert!(!repeats_after(None, None, 0));
        assert!(!repeats_after(None, Some(5), 0));
        // Unbounded repeats stay alive forever.
        assert!(repeats_after(Some(60), None, 0));
        assert!(repeats_after(Some(60), None, 9999));
        // A bounded schedule stops after its last fire: fires counts deliveries.
        assert!(repeats_after(Some(60), Some(3), 0));
        assert!(repeats_after(Some(60), Some(3), 1));
        assert!(!repeats_after(Some(60), Some(3), 2));
        assert!(!repeats_after(Some(60), Some(1), 0));
    }

    #[test]
    fn chat_host_stores_a_recurring_schedule_with_a_label() {
        let (hosts, execution) = hosts();
        let reply = hosts
            .execute(
                "group-orders",
                "Lead",
                "wakeup.schedule",
                &json!({
                    "delay_seconds": 60,
                    "intent": "poll the queue",
                    "label": "  order poller  ",
                    "repeat_seconds": 300,
                    "repeat_count": 4
                }),
            )
            .unwrap();
        assert!(reply.contains("'order poller'"), "{reply}");
        assert!(
            reply.contains("4 times, first in 60s then every 300s"),
            "{reply}"
        );
        let listed = execution.chat_wakeups_for("group-orders").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].label.as_deref(), Some("order poller"));
        assert_eq!(listed[0].repeat_seconds, Some(300));
        assert_eq!(listed[0].repeat_count, Some(4));
        assert_eq!(listed[0].fires, 0);
        assert_eq!(listed[0].state, "queued");
        // The stored body is clean: the marker is added only on delivery.
        assert_eq!(listed[0].message, "Intent: poll the queue");
        // Unbounded recurrence and rejection of a count on its own.
        assert!(hosts
            .execute(
                "group-orders",
                "Lead",
                "wakeup.schedule",
                &json!({"delay_seconds": 60, "intent": "again", "repeat_seconds": 120})
            )
            .unwrap()
            .contains("until cancelled"));
        assert!(hosts
            .execute(
                "group-orders",
                "Lead",
                "wakeup.schedule",
                &json!({"delay_seconds": 60, "intent": "bad", "repeat_count": 2})
            )
            .is_err());
        assert_eq!(execution.chat_wakeups_for("group-orders").unwrap().len(), 2);
        // A label is bounded and may not be blank or oversized.
        let long = "x".repeat(MAX_WAKEUP_LABEL + 1);
        for bad in ["   ", long.as_str()] {
            assert!(
                hosts
                    .execute(
                        "group-orders",
                        "Lead",
                        "wakeup.schedule",
                        &json!({"delay_seconds": 60, "intent": "x", "label": bad})
                    )
                    .is_err(),
                "{bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn task_rooms_refuse_recurrence_before_delegating() {
        let (hosts, _execution) = hosts();
        for args in [
            json!({"delay_seconds": 60, "intent": "check", "repeat_seconds": 60}),
            json!({"delay_seconds": 60, "intent": "check", "repeat_count": 2}),
        ] {
            let error = hosts
                .execute("task-tk_1", "Lead", "wakeup.schedule", &args)
                .unwrap_err()
                .to_string();
            assert!(
                error.contains("recurring wakeups are supported in chat rooms"),
                "{error}"
            );
        }
        // A label alone still delegates, so the task-room error is unchanged.
        let error = hosts
            .execute(
                "task-tk_1",
                "Lead",
                "wakeup.schedule",
                &json!({"delay_seconds": 60, "intent": "check", "label": "nightly"}),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("no live task attempt"), "{error}");
    }
}
