//! Typed coordination state: task lifecycle, attempts, messages, groups.
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name { $($variant),+ }
        impl $name {
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $text),+ }
            }
            pub fn parse(text: &str) -> Option<Self> {
                match text { $($text => Some(Self::$variant),)+ _ => None }
            }
        }
    };
}

string_enum!(
    /// `submitted → planning → ready → running → review → completed`, plus
    /// `blocked`, `needs_input`, `failed`, `cancelled`.
    TaskStatus {
        Submitted => "submitted",
        Planning => "planning",
        Ready => "ready",
        Running => "running",
        Review => "review",
        Completed => "completed",
        Blocked => "blocked",
        NeedsInput => "needs_input",
        Failed => "failed",
        Cancelled => "cancelled",
    }
);

impl TaskStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    /// Whether the lifecycle permits `self → next`. Terminal states never move.
    pub fn can_transition_to(self, next: Self) -> bool {
        use TaskStatus::*;
        if self == next {
            return false;
        }
        if self.is_terminal() {
            return false;
        }
        if matches!(next, Cancelled | Failed) {
            return true;
        }
        matches!(
            (self, next),
            (Submitted, Planning)
                | (Submitted, Ready)
                | (Submitted, NeedsInput)
                | (Submitted, Blocked)
                | (Submitted, Running)
                | (Planning, Running)
                | (Planning, Ready)
                | (Planning, NeedsInput)
                | (Planning, Blocked)
                | (Ready, Running)
                | (Ready, Blocked)
                | (Ready, NeedsInput)
                | (Running, Review)
                | (Running, Ready)
                | (Running, Blocked)
                | (Running, NeedsInput)
                | (Review, Completed)
                | (Review, Ready)
                | (Review, Planning)
                | (Review, Blocked)
                | (Review, Running)
                | (Blocked, Ready)
                | (Blocked, Submitted)
                | (Blocked, Planning)
                | (Blocked, Review)
                | (Blocked, Running)
                | (NeedsInput, Submitted)
                | (NeedsInput, Planning)
                | (NeedsInput, Ready)
                | (NeedsInput, Blocked)
        )
    }
}

string_enum!(TaskKind { Work => "work", Integrate => "integrate" });

string_enum!(AttemptKind {
    Plan => "plan",
    Work => "work",
    Review => "review",
    Inbox => "inbox",
});

string_enum!(AttemptState {
    Running => "running",
    Succeeded => "succeeded",
    Failed => "failed",
    Cancelled => "cancelled",
    Interrupted => "interrupted",
});

string_enum!(MessageKind {
    Request => "request",
    Handoff => "handoff",
    Status => "status",
    DecisionProposal => "decision_proposal",
    Ack => "ack",
    Wakeup => "wakeup",
});

impl MessageKind {
    /// Only requests and designated handoffs schedule recipient work;
    /// acknowledgments and status reports never do, so they cannot loop.
    pub fn wakes_recipient(self) -> bool {
        matches!(self, Self::Request | Self::Handoff)
    }
}

string_enum!(DeliveryState {
    Queued => "queued",
    Delivered => "delivered",
    Processing => "processing",
    Acknowledged => "acknowledged",
    Failed => "failed",
    Cancelled => "cancelled",
});

string_enum!(Verdict { Passed => "passed", Failed => "failed", Unavailable => "unavailable" });

#[derive(Debug, Clone, Serialize)]
pub struct Task {
    pub id: String,
    pub root_id: String,
    pub parent_id: Option<String>,
    pub depth: u32,
    pub kind: TaskKind,
    pub objective: String,
    pub acceptance: Vec<String>,
    pub capabilities: Vec<String>,
    pub workspace: String,
    pub coordinator: String,
    pub owner: Option<String>,
    pub reviewer: Option<String>,
    pub status: TaskStatus,
    pub status_reason: Option<String>,
    pub revision: i64,
    pub paused: bool,
    pub feedback: Vec<String>,
    pub prerequisites: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Attempt {
    pub id: String,
    pub task_id: String,
    pub kind: AttemptKind,
    pub persona: String,
    pub instance_id: String,
    pub runtime_epoch: Option<String>,
    pub dispatch_id: String,
    pub fencing: i64,
    pub lease_expires_at: i64,
    pub heartbeat_at: i64,
    pub state: AttemptState,
    pub failure_class: Option<String>,
    #[serde(skip)]
    pub failure_detail: Option<String>,
    #[serde(skip)]
    pub worktree: Option<String>,
    pub branch: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    #[serde(skip)]
    pub context_metrics: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Artifact {
    pub id: String,
    pub task_id: String,
    pub attempt_id: Option<String>,
    pub kind: String,
    pub reference: String,
    pub version: i64,
    pub content_hash: Option<String>,
    pub description: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Evidence {
    pub check: String,
    pub outcome: Verdict,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub id: String,
    pub root_id: String,
    pub task_id: String,
    pub thread: String,
    pub sender: String,
    pub sender_instance: String,
    pub kind: MessageKind,
    pub recipients: Vec<String>,
    pub group_id: Option<String>,
    pub body: String,
    pub artifacts: Vec<String>,
    pub correlation_id: String,
    pub causation_id: Option<String>,
    pub depth: u32,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Delivery {
    pub message_id: String,
    pub recipient: String,
    pub state: DeliveryState,
    pub wake: bool,
    pub attempts: u32,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Group {
    pub id: String,
    pub root_id: String,
    pub task_id: String,
    pub purpose: String,
    pub creator: String,
    pub active: bool,
    pub revision: i64,
    pub members: Vec<GroupMember>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct GroupMember {
    pub persona: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Decision {
    pub id: String,
    pub task_id: String,
    pub text: String,
    pub proposer: String,
    pub source_message: Option<String>,
    /// `proposed`, `accepted`, `rejected`.
    pub state: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CoordinationEvent {
    pub seq: i64,
    pub root_id: String,
    pub task_id: Option<String>,
    pub actor: String,
    pub event_type: String,
    pub payload: serde_json::Value,
    pub created_at: i64,
}

/// Counters charged to one root task and everything under it.
#[derive(Debug, Clone, Serialize)]
pub struct Usage {
    pub dispatches: u32,
    pub dispatch_limit: u32,
    pub tool_actions: u32,
    pub tool_action_limit: u32,
    pub messages: u32,
    pub message_limit: u32,
    pub started_at: i64,
    pub deadline: i64,
    /// Runtime token usage is not measured for task dispatches.
    pub tokens: Option<u64>,
}

/// Errors callers can match on; everything else is an internal failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoordError {
    NotFound(String),
    Invalid(String),
    Forbidden(String),
    /// Stale revision, illegal transition, or stale lease.
    Conflict(String),
    Disabled,
    Budget(String),
    Internal(String),
}

impl std::fmt::Display for CoordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(m)
            | Self::Invalid(m)
            | Self::Forbidden(m)
            | Self::Conflict(m)
            | Self::Budget(m)
            | Self::Internal(m) => f.write_str(m),
            Self::Disabled => {
                f.write_str("coordination is disabled; set coordination.enabled = true")
            }
        }
    }
}

impl std::error::Error for CoordError {}

pub type CoordResult<T> = std::result::Result<T, CoordError>;

/// Bounded identifier/label text: ASCII-friendly, no control characters.
pub fn check_text(field: &str, value: &str, max: usize) -> CoordResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(CoordError::Invalid(format!("{field} must not be empty")));
    }
    if value.len() > max {
        return Err(CoordError::Invalid(format!("{field} exceeds {max} bytes")));
    }
    if value
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(CoordError::Invalid(format!(
            "{field} contains control characters"
        )));
    }
    Ok(value.to_owned())
}

/// Longest prefix of `text` within `max` bytes on a char boundary.
pub fn clip(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

pub fn new_id(prefix: &str) -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!(
        "{prefix}_{nanos:016x}{:04x}{sequence:04x}",
        std::process::id() & 0xffff
    )
}

/// Room that holds all task-scoped conversation for `task_id`.
pub fn task_room(task_id: &str) -> String {
    format!("task-{task_id}")
}

pub fn task_of_room(room: &str) -> Option<&str> {
    room.strip_prefix("task-")
        .filter(|id| id.starts_with("tk_"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_states_never_transition_and_lifecycle_is_forward() {
        for terminal in [
            TaskStatus::Completed,
            TaskStatus::Failed,
            TaskStatus::Cancelled,
        ] {
            for next in [
                TaskStatus::Ready,
                TaskStatus::Running,
                TaskStatus::Review,
                TaskStatus::Cancelled,
            ] {
                assert!(!terminal.can_transition_to(next));
            }
        }
        assert!(TaskStatus::Ready.can_transition_to(TaskStatus::Running));
        assert!(!TaskStatus::Ready.can_transition_to(TaskStatus::Completed));
        assert!(!TaskStatus::Running.can_transition_to(TaskStatus::Completed));
        assert!(TaskStatus::Review.can_transition_to(TaskStatus::Completed));
    }

    #[test]
    fn only_requests_and_handoffs_wake_recipients() {
        for kind in [
            MessageKind::Status,
            MessageKind::Ack,
            MessageKind::DecisionProposal,
        ] {
            assert!(!kind.wakes_recipient());
        }
        assert!(MessageKind::Request.wakes_recipient() && MessageKind::Handoff.wakes_recipient());
    }

    #[test]
    fn clip_respects_char_boundaries() {
        assert_eq!(clip("a☃b", 2), "a");
        assert_eq!(task_of_room(&task_room("tk_1")), Some("tk_1"));
        assert_eq!(task_of_room("task-other"), None);
    }
}
