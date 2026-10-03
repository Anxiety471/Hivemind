//! Agents inject a prompt into another agent by queueing a chat job.
//!
//! `ConversationTarget` is not serializable. Jobs store the same JSON shape as
//! `POST /api/v1/turns` (`{"type":"main"}`, `solo`, `group`, `thread`), plus
//! optional delivery fields the worker reads back.
use std::sync::{Arc, RwLock};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use super::{resolve_loaded, AgentRegistry, ConversationTarget, ResolvedConversationTarget};
use crate::{
    config::HivemindConfig,
    conversation::ToolHost,
    coordination::model::{check_text, task_of_room},
    execution::ExecutionStore,
    memory::{Caller, MemoryService},
    shared_workspace::SharedWorkspaces,
};

/// Deepest stored wakeup. Depths 0..=3 are four injections; the next one stops.
const MAX_WAKE_DEPTH: u32 = 4;
const MAX_BODY: usize = 6000;

/// A parsed `jobs.target` value. `persona` limits who replies; `from` marks the
/// turn as injected by an agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedJobTarget {
    pub target: ConversationTarget,
    pub persona: Option<String>,
    pub from: Option<String>,
    pub wake: Option<String>,
    pub depth: u32,
    pub causation: Option<String>,
}

struct WakeMeta {
    persona: Option<String>,
    from: String,
    wake: String,
    depth: u32,
    causation: Option<String>,
}

/// Build the job target object. Do not derive serde on [`ConversationTarget`].
fn job_target_json(target: &ConversationTarget, meta: &WakeMeta) -> Value {
    let mut value = match target {
        ConversationTarget::Main => json!({"type": "main"}),
        ConversationTarget::Solo { persona_id } => json!({"type": "solo", "id": persona_id}),
        ConversationTarget::Group { group_id } => json!({"type": "group", "id": group_id}),
        ConversationTarget::Thread { thread_id } => json!({"type": "thread", "id": thread_id}),
    };
    if let Some(persona) = &meta.persona {
        value["persona"] = json!(persona);
    }
    value["from"] = json!(meta.from);
    value["wake"] = json!(meta.wake);
    if meta.depth > 0 {
        value["depth"] = json!(meta.depth);
    }
    if let Some(causation) = &meta.causation {
        value["causation"] = json!(causation);
    }
    value
}

/// Accepts ordinary turn targets and wakeup targets. Extra unknown keys are ignored.
pub fn parse_job_target(value: &Value) -> Option<ParsedJobTarget> {
    let kind = value.get("type").and_then(Value::as_str)?;
    let id = value.get("id").and_then(Value::as_str);
    let target = match kind {
        "main" => {
            if id.is_some() {
                return None;
            }
            ConversationTarget::Main
        }
        "solo" => ConversationTarget::Solo {
            persona_id: non_empty(id)?,
        },
        "group" => ConversationTarget::Group {
            group_id: non_empty(id)?,
        },
        "thread" => ConversationTarget::Thread {
            thread_id: non_empty(id)?,
        },
        _ => return None,
    };
    let persona = optional_string(value, "persona")?;
    let from = optional_string(value, "from")?;
    let wake = optional_string(value, "wake")?;
    if let Some(wake) = &wake {
        if wake != "request" && wake != "ack" {
            return None;
        }
    }
    let depth = match value.get("depth") {
        None => 0,
        Some(Value::Number(n)) => n.as_u64().filter(|n| *n <= u64::from(u32::MAX))? as u32,
        Some(_) => return None,
    };
    let causation = optional_string(value, "causation")?;
    Some(ParsedJobTarget {
        target,
        persona,
        from,
        wake,
        depth,
        causation,
    })
}

fn non_empty(id: Option<&str>) -> Option<String> {
    id.map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

fn optional_string(value: &Value, key: &str) -> Option<Option<String>> {
    match value.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(text)) => {
            let text = text.trim();
            if text.is_empty() || text.len() > 200 {
                None
            } else {
                Some(Some(text.to_owned()))
            }
        }
        Some(_) => None,
    }
}

/// Banner wrapped around an injected body when the job is delivered.
pub(super) fn wakeup_prompt(from: &str, wake: Option<&str>, body: &str) -> String {
    let note = if wake == Some("ack") {
        "This is an acknowledgement. Reply in one short sentence. Do not call chat.wakeup."
    } else {
        "Reply to them. A short acknowledgement is enough when you have nothing new to add. Call chat.wakeup only to give another agent new work."
    };
    format!("[Hivemind: {from} injected this prompt for you. It was not typed by the user. {note}]\n{body}")
}

pub(super) struct ChatWakeups {
    execution: Arc<ExecutionStore>,
    memory: Arc<MemoryService>,
    config: Arc<RwLock<Arc<HivemindConfig>>>,
    agents: Arc<RwLock<AgentRegistry>>,
    workspaces: Arc<SharedWorkspaces>,
}

impl ChatWakeups {
    pub(super) fn new(
        execution: Arc<ExecutionStore>,
        memory: Arc<MemoryService>,
        config: Arc<RwLock<Arc<HivemindConfig>>>,
        agents: Arc<RwLock<AgentRegistry>>,
        workspaces: Arc<SharedWorkspaces>,
    ) -> Self {
        Self {
            execution,
            memory,
            config,
            agents,
            workspaces,
        }
    }

    fn resolve(
        &self,
        target: &ConversationTarget,
    ) -> std::result::Result<ResolvedConversationTarget, String> {
        let registry = self
            .agents
            .read()
            .expect("core agent registry lock poisoned")
            .clone();
        let config = self.config.read().expect("core config lock poisoned");
        resolve_loaded(
            target,
            &registry,
            config.as_ref(),
            &self.memory,
            &self.workspaces,
        )
        .map_err(|error| error.to_string())
    }

    /// Queue a prompt from `persona` in `room`. Returns when the job is stored,
    /// before the recipient replies.
    pub(super) fn inject(&self, room: &str, persona: &str, args: &Value) -> Result<String> {
        if task_of_room(room).is_some() {
            bail!("chat.wakeup is for conversation rooms; on a task use messages.send, including a descendant task id");
        }
        let body = check_text("body", &string_arg(args, "body")?, MAX_BODY)
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        let to = optional_arg(args, "to")?;
        let thread = optional_arg(args, "thread")?;
        let wake = optional_arg(args, "wake")?.unwrap_or_else(|| "request".into());
        if wake != "request" && wake != "ack" {
            bail!("wake must be request or ack");
        }
        let key = optional_arg(args, "key")?;
        if let Some(key) = &key {
            check_text("key", key, 128).map_err(|error| anyhow::anyhow!("{error}"))?;
        }
        let caller = Caller::trusted_user("wakeups");
        let (destination, target) = self.destination(room, thread.as_deref(), &caller)?;
        let resolved = self
            .resolve(&target)
            .map_err(|error| anyhow::anyhow!(error))?;
        if resolved.participants.is_empty() {
            bail!("that room has no participants");
        }
        let same_room = destination == room;
        if same_room && to.is_none() {
            bail!("name who should reply with to");
        }
        if let Some(to) = &to {
            if !resolved
                .participants
                .iter()
                .any(|participant| participant.agent.name == *to)
            {
                bail!("'{to}' is not in that room");
            }
            if same_room && to == persona {
                bail!("cannot wake yourself");
            }
        }
        let (depth, causation) = self.chain(room, &wake)?;
        let meta = WakeMeta {
            persona: to.clone(),
            from: persona.to_owned(),
            wake,
            depth,
            causation,
        };
        let target_json = job_target_json(&target, &meta);
        let job = self
            .execution
            .submit(&resolved.room_id, &target_json, &body, key.as_deref())?;
        let who = to.as_deref().unwrap_or("the room");
        Ok(format!(
            "queued wakeup {} for {who} in {}; they reply when that room is free",
            job.turn_id, resolved.room_id
        ))
    }

    fn destination(
        &self,
        room: &str,
        thread: Option<&str>,
        caller: &Caller,
    ) -> Result<(String, ConversationTarget)> {
        let destination = if thread == Some("parent") {
            let current = self
                .memory
                .thread(caller, room)
                .context("reading the current thread")?
                .context("this room is not a thread, so it has no parent")?;
            current.parent_room_id
        } else if let Some(thread_id) = thread {
            let child = self
                .memory
                .thread(caller, thread_id)
                .context("reading the child thread")?
                .context("unknown thread")?;
            if child.parent_room_id != room {
                bail!("that thread is not a child of this room");
            }
            child.id
        } else {
            room.to_owned()
        };
        let target = self.target_for_room(&destination, caller)?;
        Ok((destination, target))
    }

    fn target_for_room(&self, room: &str, caller: &Caller) -> Result<ConversationTarget> {
        if let Some(thread) = self.memory.thread(caller, room).context("reading room")? {
            return Ok(ConversationTarget::Thread {
                thread_id: thread.id,
            });
        }
        super::parent_target(room).context("that room is not a conversation")
    }

    /// Depth and causation from the wakeup job currently running in this room.
    /// An acknowledgement turn cannot inject anything further.
    fn chain(&self, room: &str, wake: &str) -> Result<(u32, Option<String>)> {
        let Some(job) = self
            .execution
            .running_for_room(room)
            .context("reading the running turn")?
        else {
            if wake == "ack" {
                bail!("an acknowledgement answers a wakeup you received");
            }
            return Ok((0, None));
        };
        let Some(parsed) = parse_job_target(&job.target) else {
            if wake == "ack" {
                bail!("an acknowledgement answers a wakeup you received");
            }
            return Ok((0, None));
        };
        if parsed.from.is_none() {
            if wake == "ack" {
                bail!("an acknowledgement answers a wakeup you received");
            }
            return Ok((0, None));
        }
        if parsed.wake.as_deref() == Some("ack") {
            bail!("this turn is an acknowledgement and cannot inject another prompt");
        }
        let depth = parsed.depth.saturating_add(1);
        if depth >= MAX_WAKE_DEPTH {
            bail!("wakeup chain is at its limit; reply here instead of injecting another prompt");
        }
        Ok((depth, Some(job.turn_id)))
    }
}

pub(super) struct ChatWakeupTools {
    wakeups: Arc<ChatWakeups>,
}

impl ChatWakeupTools {
    pub(super) fn new(wakeups: Arc<ChatWakeups>) -> Self {
        Self { wakeups }
    }
}

impl ToolHost for ChatWakeupTools {
    fn manifest(&self, room: &str, _persona: &str) -> Option<String> {
        if task_of_room(room).is_some() || !conversation_room(room) {
            return None;
        }
        Some(
            "\nHivemind chat wakeups (same ```hivemind-tool fence; one call per reply as your whole reply): chat.wakeup(body, to?, thread?, wake?, key?)\n\
Inject a prompt into another agent. It is queued; you do not wait for the reply.\n\
- to: who replies. Required when waking someone in this room. Optional for a child thread or your parent room, which otherwise wakes that whole room.\n\
- thread: a child thread id of this room, or \"parent\" when this room is a thread.\n\
- wake: \"request\" (default) or \"ack\". An acknowledgement is delivered once and cannot cause another wakeup.\n\
A chain stops after 4 injections. You cannot wake yourself in this room. Example: {\"name\":\"chat.wakeup\",\"args\":{\"to\":\"Reviewer\",\"body\":\"Please confirm the schema.\"}}\n"
                .into(),
        )
    }

    fn reminder(&self, room: &str, _persona: &str) -> Option<String> {
        if task_of_room(room).is_some() || !conversation_room(room) {
            None
        } else {
            Some(
                "chat.wakeup remains available to inject a prompt into a teammate, a child thread, or your parent room.\n"
                    .into(),
            )
        }
    }

    fn handles(&self, name: &str) -> bool {
        name == "chat.wakeup"
    }

    fn execute(&self, room: &str, persona: &str, name: &str, args: &Value) -> Result<String> {
        if name != "chat.wakeup" {
            bail!("unknown chat tool '{name}'");
        }
        self.wakeups.inject(room, persona, args)
    }
}

fn conversation_room(room: &str) -> bool {
    room == "main"
        || room.starts_with("solo-")
        || room.starts_with("group-")
        || room.starts_with("thread-")
}

fn string_arg(args: &Value, key: &str) -> Result<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .with_context(|| format!("'{key}' must be a string"))
}

fn optional_arg(args: &Value, key: &str) -> Result<Option<String>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.trim().to_owned())),
        Some(_) => bail!("'{key}' must be a string"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::{ConversationMode, GroupConfig, HivemindConfig},
        core::HivemindCore,
        memory::ArchivedMessage,
    };
    use std::time::{SystemTime, UNIX_EPOCH};

    fn directory() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "hivemind-wakeups-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn core(path: &std::path::Path) -> HivemindCore {
        let mut config = HivemindConfig::default_poc();
        config.groups.push(GroupConfig {
            name: "dev".into(),
            members: vec!["Engineer".into(), "Reviewer".into()],
            mode: ConversationMode::Discussion,
            member_roles: Default::default(),
            reply_order: Vec::new(),
            workspace: None,
        });
        HivemindCore::new(config, path.join("hivemind.toml")).unwrap()
    }

    #[test]
    fn turn_targets_round_trip_without_serializing_conversation_target() {
        for value in [
            json!({"type": "main"}),
            json!({"type": "solo", "id": "Engineer"}),
            json!({"type": "group", "id": "dev"}),
            json!({"type": "thread", "id": "thread-1"}),
        ] {
            let parsed = parse_job_target(&value).unwrap();
            assert!(parsed.from.is_none() && parsed.persona.is_none());
            assert_eq!(parsed.depth, 0);
        }
        let built = job_target_json(
            &ConversationTarget::Group {
                group_id: "dev".into(),
            },
            &WakeMeta {
                persona: Some("Reviewer".into()),
                from: "Engineer".into(),
                wake: "request".into(),
                depth: 0,
                causation: None,
            },
        );
        assert_eq!(
            built,
            json!({"type": "group", "id": "dev", "persona": "Reviewer", "from": "Engineer", "wake": "request"})
        );
        let parsed = parse_job_target(&built).unwrap();
        assert!(matches!(parsed.target, ConversationTarget::Group { .. }));
        assert!(parse_job_target(&json!({"type": "main", "id": "nope"})).is_none());
        assert!(parse_job_target(&json!({"type": "nope"})).is_none());
    }

    #[test]
    fn an_agent_wakes_one_teammate_and_an_ack_cannot_chain() {
        let path = directory();
        let core = core(&path);
        let tools = ChatWakeupTools::new(core.wakeups.clone());
        assert!(tools
            .manifest("group-dev", "Engineer")
            .unwrap()
            .contains("chat.wakeup"));
        assert!(tools.manifest("task-tk_abc", "Engineer").is_none());
        let queued = tools
            .execute(
                "group-dev",
                "Engineer",
                "chat.wakeup",
                &json!({"to": "Reviewer", "body": "Please confirm the schema."}),
            )
            .unwrap();
        assert!(queued.contains("Reviewer"));
        let job = core
            .execution()
            .latest_for_room("group-dev")
            .unwrap()
            .unwrap();
        assert_eq!(job.target["type"], "group");
        assert_eq!(job.target["id"], "dev");
        assert_eq!(job.target["persona"], "Reviewer");
        assert_eq!(job.target["from"], "Engineer");
        assert_eq!(job.target["wake"], "request");
        assert_eq!(job.message, "Please confirm the schema.");
        assert!(tools
            .execute(
                "group-dev",
                "Engineer",
                "chat.wakeup",
                &json!({"body": "everyone"}),
            )
            .is_err());
        assert!(tools
            .execute(
                "group-dev",
                "Engineer",
                "chat.wakeup",
                &json!({"to": "Engineer", "body": "me"}),
            )
            .is_err());

        let claimed = core.execution().claim().unwrap().unwrap();
        assert_eq!(claimed.turn_id, job.turn_id);
        let ack = tools
            .execute(
                "group-dev",
                "Reviewer",
                "chat.wakeup",
                &json!({"to": "Engineer", "wake": "ack", "body": "Schema confirmed."}),
            )
            .unwrap();
        assert!(ack.contains("Engineer"));
        let ack_job = core
            .execution()
            .latest_for_room("group-dev")
            .unwrap()
            .unwrap();
        assert_eq!(ack_job.target["wake"], "ack");
        assert_eq!(ack_job.target["depth"], 1);
        assert_eq!(ack_job.target["causation"], job.turn_id);
        // The request job is still the running one, so finish it and run the ack.
        core.execution()
            .finish(&job.turn_id, "completed", json!({}))
            .unwrap();
        let running_ack = core.execution().claim().unwrap().unwrap();
        assert_eq!(running_ack.turn_id, ack_job.turn_id);
        let chained = tools.execute(
            "group-dev",
            "Engineer",
            "chat.wakeup",
            &json!({"to": "Reviewer", "body": "and another thing"}),
        );
        assert!(chained.is_err(), "{chained:?}");
        let _ = std::fs::remove_dir_all(&path);
    }

    #[test]
    fn parent_injects_into_a_child_thread_and_the_child_can_answer_upward() {
        let path = directory();
        let core = core(&path);
        let caller = Caller::trusted_user("test");
        core.memory()
            .append_room_message(
                &caller,
                ArchivedMessage {
                    id: "m-anchor".into(),
                    room_id: "group-dev".into(),
                    turn_id: "turn-anchor".into(),
                    speaker: "user".into(),
                    content: "discuss the schema".into(),
                    created_at: 1,
                },
            )
            .unwrap();
        let (thread, created) = core
            .memory()
            .create_thread(&caller, "group-dev", "m-anchor", "schema")
            .unwrap();
        assert!(created);
        let queued = core
            .wakeups
            .inject(
                "group-dev",
                "Engineer",
                &json!({"thread": thread.id, "body": "Also cover the error shape."}),
            )
            .unwrap();
        assert!(queued.contains(&thread.id));
        let job = core
            .execution()
            .latest_for_room(&thread.id)
            .unwrap()
            .unwrap();
        assert_eq!(job.target["type"], "thread");
        assert_eq!(job.target["id"], thread.id);
        assert!(job.target.get("persona").is_none());
        assert!(core
            .wakeups
            .inject(
                "group-dev",
                "Engineer",
                &json!({"thread": "thread-other", "body": "nope"}),
            )
            .is_err());

        core.execution().claim().unwrap();
        let upward = core
            .wakeups
            .inject(
                &thread.id,
                "Reviewer",
                &json!({"thread": "parent", "to": "Engineer", "body": "Error shape noted."}),
            )
            .unwrap();
        assert!(upward.contains("group-dev"));
        let parent_job = core
            .execution()
            .latest_for_room("group-dev")
            .unwrap()
            .unwrap();
        assert_eq!(parent_job.target["type"], "group");
        assert_eq!(parent_job.target["persona"], "Engineer");
        assert_eq!(parent_job.target["depth"], 1);
        let _ = std::fs::remove_dir_all(&path);
    }

    #[test]
    fn wakeup_prompt_tells_the_recipient_to_acknowledge() {
        let prompt = wakeup_prompt("Engineer", Some("request"), "confirm");
        assert!(
            prompt.contains("Engineer")
                && prompt.contains("acknowledgement")
                && prompt.ends_with("confirm")
        );
        assert!(wakeup_prompt("Reviewer", Some("ack"), "ok").contains("Do not call chat.wakeup"));
    }
}
