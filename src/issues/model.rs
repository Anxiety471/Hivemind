//! Issue backlog types. An issue is a proposal for later work. Filing one
//! never starts an implementation.
use serde::{Deserialize, Serialize};

use crate::config::IssuesMode;

/// Room that holds every issue-council discussion.
pub const COUNCIL_ROOM: &str = "issues";

pub const TITLE_MIN: usize = 8;
pub const TITLE_MAX: usize = 140;
pub const BODY_MIN: usize = 16;
pub const BODY_MAX: usize = 4_000;

#[derive(Debug)]
pub enum IssueError {
    Disabled,
    NotFound(String),
    Invalid(String),
    Conflict(String),
    Internal(String),
}

impl std::fmt::Display for IssueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled => f.write_str("issue council is disabled"),
            Self::NotFound(message)
            | Self::Invalid(message)
            | Self::Conflict(message)
            | Self::Internal(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for IssueError {}

pub type IssueResult<T> = Result<T, IssueError>;

impl From<rusqlite::Error> for IssueError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Internal(format!("issue store: {error}"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueKind {
    Feature,
    Improvement,
    Bug,
}

impl IssueKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Feature => "feature",
            Self::Improvement => "improvement",
            Self::Bug => "bug",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "feature" => Some(Self::Feature),
            "improvement" => Some(Self::Improvement),
            "bug" => Some(Self::Bug),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueStatus {
    Open,
    Dismissed,
}

impl IssueStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Dismissed => "dismissed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "open" => Some(Self::Open),
            "dismissed" => Some(Self::Dismissed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Low,
    #[default]
    Medium,
    High,
}

impl Priority {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Trigger {
    Automatic,
    Scheduled,
    Manual,
}

impl Trigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Automatic => "automatic",
            Self::Scheduled => "scheduled",
            Self::Manual => "manual",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "automatic" => Some(Self::Automatic),
            "scheduled" => Some(Self::Scheduled),
            "manual" => Some(Self::Manual),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoundStatus {
    Running,
    Completed,
    Failed,
}

impl RoundStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "running" => Some(Self::Running),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Issue {
    pub id: String,
    pub kind: IssueKind,
    pub title: String,
    pub body: String,
    pub status: IssueStatus,
    pub priority: Priority,
    pub proposed_by: String,
    pub round_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dismiss_reason: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Round {
    pub id: String,
    pub trigger: Trigger,
    pub status: RoundStatus,
    pub members: Vec<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub issue_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proposal {
    pub persona: String,
    pub kind: IssueKind,
    pub title: String,
    pub body: String,
    pub priority: Priority,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proposed {
    pub issue: Issue,
    pub created: bool,
}

/// Inputs for "is a council due?". `anchor` is the previous council's finish
/// time, or the moment the cadence started.
#[derive(Debug, Clone, Copy)]
pub struct Pace {
    pub mode: IssuesMode,
    pub interval_secs: u64,
    pub idle_secs: u64,
    pub now: i64,
    pub anchor: i64,
    pub idle_since: Option<i64>,
    pub busy: bool,
    pub round_running: bool,
}

pub fn pace_due(pace: Pace) -> Option<Trigger> {
    if pace.round_running {
        return None;
    }
    if pace.now.saturating_sub(pace.anchor) < pace.interval_secs as i64 {
        return None;
    }
    match pace.mode {
        IssuesMode::Scheduled => Some(Trigger::Scheduled),
        IssuesMode::Automatic => {
            if pace.busy {
                return None;
            }
            let idle_for = pace.idle_since.map(|since| pace.now.saturating_sub(since))?;
            (idle_for >= pace.idle_secs as i64).then_some(Trigger::Automatic)
        }
    }
}

pub fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn title_key(title: &str) -> String {
    collapse(title).to_lowercase()
}

pub fn clean_title(raw: &str) -> IssueResult<String> {
    let title = collapse(raw);
    let chars = title.chars().count();
    if !(TITLE_MIN..=TITLE_MAX).contains(&chars) {
        return Err(IssueError::Invalid(format!(
            "title must be {TITLE_MIN}-{TITLE_MAX} characters"
        )));
    }
    Ok(title)
}

pub fn clean_body(raw: &str) -> IssueResult<String> {
    let body = raw.trim().to_owned();
    let chars = body.chars().count();
    if !(BODY_MIN..=BODY_MAX).contains(&chars) {
        return Err(IssueError::Invalid(format!(
            "body must be {BODY_MIN}-{BODY_MAX} characters"
        )));
    }
    Ok(body)
}

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
