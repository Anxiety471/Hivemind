//! `issues.list` and `issues.propose`, offered only while a council is running
//! in the issues room. Arguments never choose the persona or the round.
use anyhow::{bail, Result};
use serde_json::{json, Value};

use super::{
    model::*,
    service::{IssuesService, RawProposal},
};
use crate::conversation::ToolHost;
use std::sync::Arc;

pub struct IssueTools {
    service: Arc<IssuesService>,
}

impl IssueTools {
    pub fn new(service: Arc<IssuesService>) -> Self {
        Self { service }
    }
}

impl ToolHost for IssueTools {
    fn manifest(&self, room: &str, persona: &str) -> Option<String> {
        let round = council(self, room, persona).ok().flatten()?;
        let max = self.service.config().max_issues_per_round;
        Some(format!(
            "Issue council tools — at most one call per reply, as exactly one fenced block:\n\
```hivemind-tool\n\
{{\"name\":\"issues.propose\",\"args\":{{\"kind\":\"bug\",\"title\":\"Retry failed webhook delivery\",\"body\":\"Deliveries drop after one attempt. Done when a failed delivery is retried with backoff and the failure is visible.\",\"priority\":\"high\"}}}}\n\
```\n\
\n\
issues.list() shows the open backlog. issues.propose(kind, title, body, priority?) files one issue for later and does not start the work. \
kind is feature, improvement, or bug. You are {persona} in council {round}. This round accepts at most {max} new issues. \
A title that is already open returns that issue instead of filing another.\n"
        ))
    }

    fn reminder(&self, room: &str, persona: &str) -> Option<String> {
        council(self, room, persona).ok().flatten()?;
        Some(
            "Issue tools remain available: issues.list, issues.propose. Filing an issue does not implement it.\n"
                .into(),
        )
    }

    fn max_actions(&self, room: &str) -> usize {
        if room == COUNCIL_ROOM {
            self.service.config().max_issues_per_round as usize + 2
        } else {
            0
        }
    }

    fn agent_originated(&self, room: &str) -> bool {
        room == COUNCIL_ROOM
    }

    fn handles(&self, name: &str) -> bool {
        matches!(name, "issues.list" | "issues.propose")
    }

    fn execute(&self, room: &str, persona: &str, name: &str, args: &Value) -> Result<String> {
        let _round = council(self, room, persona)?.ok_or_else(|| {
            anyhow::anyhow!("issues tools are only available while the issue council is running")
        })?;
        let text = match name {
            "issues.list" => list_issues(&self.service, args)?,
            "issues.propose" => propose(&self.service, persona, args)?,
            other => bail!("unknown issue tool '{other}'"),
        };
        Ok(text)
    }
}

fn council(tools: &IssueTools, room: &str, persona: &str) -> Result<Option<String>> {
    if room != COUNCIL_ROOM || !tools.service.enabled() {
        return Ok(None);
    }
    let Some(round) = tools.service.running().map_err(|error| anyhow::anyhow!(error.to_string()))?
    else {
        return Ok(None);
    };
    if !round.members.iter().any(|member| member == persona) {
        return Ok(None);
    }
    Ok(Some(round.id))
}

fn list_issues(service: &IssuesService, args: &Value) -> Result<String> {
    let status = match arg(args, "status") {
        None => Some(IssueStatus::Open),
        Some("all") => None,
        Some(value) => Some(
            IssueStatus::parse(value)
                .ok_or_else(|| anyhow::anyhow!("status must be open, dismissed, or all"))?,
        ),
    };
    let kind = match arg(args, "kind") {
        None => None,
        Some(value) => Some(
            IssueKind::parse(value)
                .ok_or_else(|| anyhow::anyhow!("kind must be feature, improvement, or bug"))?,
        ),
    };
    let issues = service
        .list(status, kind)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if issues.is_empty() {
        return Ok("No issues.".into());
    }
    let mut out = String::new();
    for issue in issues.iter().take(30) {
        out.push_str(&format!(
            "{} [{}] {} — {} (by {})\n{}\n\n",
            issue.id,
            issue.kind.as_str(),
            issue.priority.as_str(),
            issue.title,
            issue.proposed_by,
            clip(&issue.body, 240)
        ));
    }
    if issues.len() > 30 {
        out.push_str(&format!("({} more)\n", issues.len() - 30));
    }
    Ok(out)
}

fn propose(service: &IssuesService, persona: &str, args: &Value) -> Result<String> {
    let kind = arg(args, "kind")
        .and_then(IssueKind::parse)
        .ok_or_else(|| anyhow::anyhow!("kind must be feature, improvement, or bug"))?;
    let title = arg(args, "title").unwrap_or("").to_owned();
    let body = args
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let priority = match arg(args, "priority") {
        None => Priority::Medium,
        Some(value) => Priority::parse(value)
            .ok_or_else(|| anyhow::anyhow!("priority must be low, medium, or high"))?,
    };
    let proposed = service
        .propose(RawProposal {
            persona: persona.to_owned(),
            kind,
            title,
            body,
            priority,
        })
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    Ok(json!({
        "id": proposed.issue.id,
        "created": proposed.created,
        "kind": proposed.issue.kind.as_str(),
        "title": proposed.issue.title,
        "status": proposed.issue.status.as_str(),
        "note": if proposed.created {
            "Filed. This issue is not being implemented."
        } else {
            "Already open. Not filed again."
        }
    })
    .to_string())
}

fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}
