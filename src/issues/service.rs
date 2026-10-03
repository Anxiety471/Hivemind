//! Backlog operations. Scheduling decides when a council runs; this type only
//! stores what the council files.
use parking_lot::RwLock;

use super::{
    model::*,
    store::IssueStore,
};
use crate::{
    config::{HivemindConfig, IssuesConfig},
    events::{DomainEventKind, EventBus},
};

pub struct IssuesService {
    store: IssueStore,
    config: RwLock<IssuesConfig>,
    events: EventBus,
}

impl IssuesService {
    pub fn new(store: IssueStore, config: IssuesConfig, events: EventBus) -> Self {
        Self {
            store,
            config: RwLock::new(config),
            events,
        }
    }

    pub fn config(&self) -> IssuesConfig {
        self.config.read().clone()
    }

    pub fn set_config(&self, config: IssuesConfig) {
        *self.config.write() = config;
    }

    pub fn enabled(&self) -> bool {
        self.config.read().enabled
    }

    pub fn now(&self) -> i64 {
        self.store.now()
    }

    pub fn anchor(&self, now: i64) -> IssueResult<i64> {
        self.store.anchor(now)
    }

    pub fn list(
        &self,
        status: Option<IssueStatus>,
        kind: Option<IssueKind>,
    ) -> IssueResult<Vec<Issue>> {
        self.store.list(status, kind, 200)
    }

    pub fn get(&self, id: &str) -> IssueResult<Issue> {
        self.store.get(id)
    }

    pub fn rounds(&self, limit: usize) -> IssueResult<Vec<Round>> {
        self.store.rounds(limit)
    }

    pub fn round(&self, id: &str) -> IssueResult<Round> {
        self.store.round(id)
    }

    pub fn running(&self) -> IssueResult<Option<Round>> {
        self.store.running()
    }

    pub fn dismiss(&self, id: &str, reason: Option<String>) -> IssueResult<Issue> {
        let reason = match reason {
            Some(reason) => {
                let reason = reason.trim().to_owned();
                if reason.chars().count() > 500 {
                    return Err(IssueError::Invalid(
                        "dismiss reason must be at most 500 characters".into(),
                    ));
                }
                Some(reason).filter(|reason| !reason.is_empty())
            }
            None => None,
        };
        let issue = self.store.dismiss(id, reason)?;
        self.publish("issue.dismissed", Some(issue.id.clone()), Some(issue.round_id.clone()));
        Ok(issue)
    }

    pub fn begin_round(&self, trigger: Trigger, members: &[String]) -> IssueResult<Round> {
        if !self.enabled() {
            return Err(IssueError::Disabled);
        }
        if members.is_empty() {
            return Err(IssueError::Invalid(
                "the issue council has no members".into(),
            ));
        }
        let round = self.store.begin_round(trigger, members)?;
        self.publish(
            "issue.round.started",
            None,
            Some(round.id.clone()),
        );
        Ok(round)
    }

    pub fn finish_round(&self, id: &str, error: Option<String>) -> IssueResult<Option<Round>> {
        let error = error.map(|error| clip(&error, 300).to_owned());
        let Some(round) = self.store.finish_round(id, error)? else {
            return Ok(None);
        };
        let event = match round.status {
            RoundStatus::Failed => "issue.round.failed",
            _ => "issue.round.completed",
        };
        self.publish(event, None, Some(round.id.clone()));
        Ok(Some(round))
    }

    pub fn interrupt_running(&self) -> IssueResult<u32> {
        self.store.interrupt_running()
    }

    pub fn propose(&self, raw: RawProposal) -> IssueResult<Proposed> {
        let proposal = Proposal {
            persona: raw.persona,
            kind: raw.kind,
            title: clean_title(&raw.title)?,
            body: clean_body(&raw.body)?,
            priority: raw.priority,
        };
        let max = self.config.read().max_issues_per_round;
        let proposed = self.store.propose(proposal, max)?;
        if proposed.created {
            self.publish(
                "issue.proposed",
                Some(proposed.issue.id.clone()),
                Some(proposed.issue.round_id.clone()),
            );
        }
        Ok(proposed)
    }

    pub fn discussion_prompt(&self) -> IssueResult<String> {
        let (open, total) = self.store.open_oldest(40)?;
        Ok(render_prompt(&self.config(), &open, total))
    }

    fn publish(&self, event_type: &str, issue_id: Option<String>, round_id: Option<String>) {
        self.events.publish(DomainEventKind::Issue {
            event_type: event_type.to_owned(),
            issue_id,
            round_id,
        });
    }
}

pub struct RawProposal {
    pub persona: String,
    pub kind: IssueKind,
    pub title: String,
    pub body: String,
    pub priority: Priority,
}

pub fn resolve_members(config: &HivemindConfig) -> IssueResult<Vec<String>> {
    if let Some(name) = &config.issues.group {
        let group = config
            .groups
            .iter()
            .find(|group| &group.name == name)
            .ok_or_else(|| IssueError::Invalid(format!("unknown group '{name}'")))?;
        let names: Vec<String> = config
            .ordered_group_members(group)
            .into_iter()
            .map(|agent| agent.name.clone())
            .collect();
        if names.is_empty() {
            return Err(IssueError::Invalid(format!(
                "group '{name}' has no members"
            )));
        }
        return Ok(names);
    }
    if !config.issues.members.is_empty() {
        return Ok(config.issues.members.clone());
    }
    let names: Vec<String> = config
        .ordered_agents()
        .into_iter()
        .map(|agent| agent.name.clone())
        .collect();
    if names.is_empty() {
        return Err(IssueError::Invalid(
            "configure at least one persona for the issue council".into(),
        ));
    }
    Ok(names)
}

pub fn render_prompt(config: &IssuesConfig, open: &[Issue], open_total: usize) -> String {
    let mut backlog = String::new();
    if open.is_empty() {
        backlog.push_str("(none)");
    } else {
        for issue in open {
            backlog.push_str(&format!(
                "- [{}] {} ({})\n",
                issue.kind.as_str(),
                issue.title,
                issue.id
            ));
        }
        if open_total > open.len() {
            backlog.push_str(&format!(
                "({} more open issues not shown; use issues.list)\n",
                open_total - open.len()
            ));
        }
    }
    let workspace = match &config.workspace {
        Some(path) => format!("When you decide, consider this workspace: {path}"),
        None => "Use what you already know about your workspace.".to_owned(),
    };
    format!(
        "This is the issue council. Discuss what the hive should add next: features, improvements, and bug fixes. \
File the ones worth doing later with issues.propose. Do not implement them, do not edit the project, and do not start a task. \
Issues stay in the backlog until someone implements them later.\n\n\
kind is \"feature\", \"improvement\", or \"bug\". title is a short imperative ({TITLE_MIN}-{TITLE_MAX} characters). \
body says why it matters and what done looks like. priority is optional: \"low\", \"medium\", or \"high\".\n\n\
This round can add at most {max} issues. Do not refile an open issue. If nothing new is worth adding, say so and file nothing.\n\n\
Open backlog:\n{backlog}\n{workspace}\n\n\
When you are done filing, answer in plain text with a short summary of what you decided.",
        max = config.max_issues_per_round,
    )
}

pub fn write_config_section(
    document: &mut toml_edit::DocumentMut,
    issues: &IssuesConfig,
) -> anyhow::Result<()> {
    #[derive(serde::Serialize)]
    struct Wrap<'a> {
        issues: &'a IssuesConfig,
    }
    let rendered = toml::to_string(&Wrap { issues })?.parse::<toml_edit::DocumentMut>()?;
    let table = rendered
        .get("issues")
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("missing issues table"))?;
    document["issues"] = table;
    Ok(())
}
