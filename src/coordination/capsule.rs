//! Lean, deterministic task prompts. The capsule is built from structured
//! state only (no model summarization) and every section has its own byte
//! budget; mandatory content is never clipped — an oversized goal fails the
//! dispatch instead of being silently truncated.
use std::collections::HashSet;

use serde_json::{json, Value};

use super::{
    model::*,
    service::{CoordinationService, Dispatch},
    store::Db,
};

pub const MAX_INBOX_ITEMS: usize = 5;
const MAX_ITEM_BYTES: usize = 1200;
const MAX_FEEDBACK: usize = 4;

pub struct Prompt {
    pub text: String,
    pub metrics: Value,
}

/// A mandatory section (goal, criteria, permissions) alone exceeds the budget.
#[derive(Debug)]
pub struct MandatoryOverflow(pub String);

impl std::fmt::Display for MandatoryOverflow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for MandatoryOverflow {}

fn instruction(kind: AttemptKind) -> &'static str {
    match kind {
        AttemptKind::Plan => "Decompose the objective into a task graph and submit it with tasks.plan.propose. Give every task an owner capability, acceptance criteria, and explicit dependencies; state interface contracts on the tasks others depend on. Include integration work when several tasks change one codebase.",
        AttemptKind::Work => "Do the work described below in your working directory, then call tasks.result.submit with what changed, artifacts, and honest verification evidence (passed, failed, or unavailable). If you cannot proceed, call tasks.block.",
        AttemptKind::Review => "Review the submitted result against the acceptance criteria. Inspect the actual artifacts (artifacts.get) rather than trusting the summary. Call tasks.review with approve or reject; a rejection must say exactly what to change.",
        AttemptKind::Inbox => "Handle the messages addressed to you below. Reply with messages.send when a reply is needed and mark each handled message with messages.ack. Do not send acknowledgments for status or ack messages.",
    }
}

fn excerpt(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.len() <= max {
        text.to_owned()
    } else {
        format!("{}…", clip(text, max))
    }
}

struct Capsule {
    text: String,
    dropped: usize,
    artifact_ids: HashSet<String>,
    dependencies: usize,
}

fn build_capsule(
    db: &Db<'_>,
    task: &Task,
    kind: AttemptKind,
    budget: usize,
) -> CoordResult<Capsule> {
    let mut lines: Vec<String> = Vec::new();
    let mut artifact_ids = HashSet::new();
    let root = db.task_or_err(&task.root_id)?;
    lines.push(format!(
        "Status: {} (revision {}). Coordinator: {}. Owner: {}. Reviewer: {}.",
        task.status.as_str(),
        task.revision,
        task.coordinator,
        task.owner.as_deref().unwrap_or("-"),
        task.reviewer.as_deref().unwrap_or("-")
    ));
    if let Some(reason) = task
        .status_reason
        .as_deref()
        .filter(|_| matches!(task.status, TaskStatus::Blocked | TaskStatus::NeedsInput))
    {
        lines.push(format!("Blocker: {reason}"));
    }
    let mut optional: Vec<String> = Vec::new();
    if task.id != root.id {
        optional.push(format!(
            "Root task {}: {}",
            root.id,
            excerpt(&root.objective, 400)
        ));
    }
    let decisions = db.decisions(&task.id, Some("accepted"))?;
    let root_decisions = if task.id != root.id {
        db.decisions(&root.id, Some("accepted"))?
    } else {
        Vec::new()
    };
    for d in root_decisions.iter().chain(decisions.iter()) {
        optional.push(format!(
            "Accepted decision {} (by {}): {}",
            d.id,
            d.proposer,
            excerpt(&d.text, 500)
        ));
    }
    let prerequisites = db.prerequisites(&task.id)?;
    for (pre_id, contract) in &prerequisites {
        let pre = db.task_or_err(pre_id)?;
        let mut line = format!(
            "Dependency {} [{}] {} — owner {}.",
            pre.id,
            pre.status.as_str(),
            excerpt(&pre.objective, 200),
            pre.owner.as_deref().unwrap_or("-")
        );
        if let Some(contract) = contract {
            line.push_str(&format!("\n  Contract: {}", excerpt(contract, 900)));
        }
        for artifact in db.artifacts(&pre.id)? {
            artifact_ids.insert(artifact.id.clone());
            if artifact.kind == "summary" {
                line.push_str(&format!(
                    "\n  Handoff summary ({}): {}",
                    artifact.id,
                    excerpt(&artifact.description, 700)
                ));
            } else {
                line.push_str(&format!(
                    "\n  Artifact {} [{}] {}",
                    artifact.id,
                    artifact.kind,
                    excerpt(&artifact.reference, 160)
                ));
            }
        }
        optional.push(line);
    }
    if kind == AttemptKind::Review || task.status == TaskStatus::Review {
        for artifact in db.artifacts(&task.id)? {
            artifact_ids.insert(artifact.id.clone());
            if artifact.kind == "summary" {
                optional.push(format!(
                    "Submitted summary ({}): {}",
                    artifact.id,
                    excerpt(&artifact.description, 900)
                ));
            } else {
                optional.push(format!(
                    "Submitted artifact {} [{}] {}",
                    artifact.id,
                    artifact.kind,
                    excerpt(&artifact.reference, 160)
                ));
            }
        }
        for e in db.latest_evidence(&task.id)? {
            optional.push(format!(
                "Evidence: {} — {} {}",
                e.check,
                e.outcome.as_str(),
                excerpt(&e.detail, 240)
            ));
        }
    }
    if task.id == root.id && matches!(kind, AttemptKind::Plan | AttemptKind::Review) {
        for child in db
            .list_tasks(&super::store::TaskFilter {
                root: Some(&root.id),
                limit: 100,
                ..Default::default()
            })?
            .iter()
            .filter(|t| t.id != root.id)
        {
            optional.push(format!(
                "Child {} [{}] owner={} — {}{}",
                child.id,
                child.status.as_str(),
                child.owner.as_deref().unwrap_or("-"),
                excerpt(&child.objective, 140),
                child
                    .status_reason
                    .as_deref()
                    .map(|r| format!(" ({r})"))
                    .unwrap_or_default()
            ));
        }
    }
    let feedback: Vec<&String> = task.feedback.iter().rev().take(MAX_FEEDBACK).collect();
    for note in feedback.into_iter().rev() {
        optional.push(format!("Feedback: {}", excerpt(note, 800)));
    }
    if let Some(usage) = db.usage(&task.root_id)? {
        lines.push(format!(
            "Root budget left: {} dispatches, {} tool actions, {} messages.",
            usage.dispatch_limit.saturating_sub(usage.dispatches),
            usage.tool_action_limit.saturating_sub(usage.tool_actions),
            usage.message_limit.saturating_sub(usage.messages)
        ));
    }
    // Keep the newest items when the section budget is exceeded.
    let mut used: usize = lines.iter().map(|l| l.len() + 1).sum();
    let mut kept: Vec<String> = Vec::new();
    let mut dropped = 0;
    for item in optional.into_iter().rev() {
        if used + item.len() + 1 > budget {
            dropped += 1;
            continue;
        }
        used += item.len() + 1;
        kept.push(item);
    }
    kept.reverse();
    lines.extend(kept);
    if dropped > 0 {
        lines.push(format!("({dropped} older capsule items omitted; use context.lookup or tasks.get for exact records)"));
    }
    Ok(Capsule {
        text: lines.join("\n"),
        dropped,
        artifact_ids,
        dependencies: prerequisites.len(),
    })
}

/// Assemble the prompt for one claimed dispatch within `budget` bytes.
pub fn build_prompt(
    service: &CoordinationService,
    dispatch: &Dispatch,
    budget: usize,
) -> CoordResult<Result<Prompt, MandatoryOverflow>> {
    let task = &dispatch.task;
    let kind = dispatch.attempt.kind;
    service.store().read(|db| {
        let header = format!("[Hivemind task dispatch — generated by Hivemind for task {}; this is not a message typed by the user]\nYour role: {}. {}\n", task.id, kind.as_str(), instruction(kind));
        let mut goal = format!("Objective:\n{}\n", task.objective);
        if !task.acceptance.is_empty() {
            goal.push_str("Acceptance criteria:\n");
            for (i, c) in task.acceptance.iter().enumerate() {
                goal.push_str(&format!("{}. {c}\n", i + 1));
            }
        }
        if let Some(project) = db.task_goal(&task.root_id)? {
            goal.push_str(&format!("Project goal {} (revision {}, {}): {}\n{}\n", project.id, project.revision, project.status, project.definition.title, project.definition.description));
            for constraint in &project.definition.constraints { goal.push_str(&format!("Project constraint: {constraint}\n")); }
            for criterion in &project.definition.success_criteria { goal.push_str(&format!("Project success criterion: {criterion}\n")); }
        }
        let mandatory = header.len() + goal.len();
        if mandatory > budget / 2 {
            return Ok(Err(MandatoryOverflow(format!(
                "task objective and acceptance criteria take {mandatory} bytes, above the {} byte mandatory budget; split the task or move detail into an artifact",
                budget / 2
            ))));
        }
        let capsule_budget = (budget - mandatory) * 3 / 5;
        let capsule = build_capsule(db, task, kind, capsule_budget)?;
        let capsule_text = format!("Task capsule:\n{}\n", capsule.text);

        // Inbox: claimed wake deliveries for inbox attempts, otherwise a bounded look at waiting mail.
        let items: Vec<(Delivery, Message)> = if kind == AttemptKind::Inbox {
            dispatch.deliveries.clone()
        } else {
            db.inbox(&dispatch.attempt.persona, &task.root_id, &[DeliveryState::Queued, DeliveryState::Delivered], MAX_INBOX_ITEMS + 1)?
        };
        let inbox_budget = budget.saturating_sub(mandatory + capsule_text.len()).min(MAX_INBOX_ITEMS * (MAX_ITEM_BYTES + 200));
        let mut inbox = String::new();
        let mut shown = 0;
        let mut inbox_truncated = false;
        for (delivery, message) in items.iter() {
            if shown >= MAX_INBOX_ITEMS {
                inbox_truncated = true;
                break;
            }
            let refs: Vec<&String> = message.artifacts.iter().filter(|a| !capsule.artifact_ids.contains(*a)).collect();
            let entry = format!(
                "- {} [{}] from {} (task {}, {}){}: {}\n",
                message.id,
                message.kind.as_str(),
                message.sender,
                message.task_id,
                delivery.state.as_str(),
                if refs.is_empty() { String::new() } else { format!(" artifacts {}", refs.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(",")) },
                excerpt(&message.body, MAX_ITEM_BYTES)
            );
            if inbox.len() + entry.len() > inbox_budget {
                inbox_truncated = true;
                break;
            }
            inbox.push_str(&entry);
            shown += 1;
        }
        let inbox_text = if inbox.is_empty() {
            String::new()
        } else {
            format!("Messages for you{}:\n{inbox}", if inbox_truncated { " (more waiting; call messages.inbox)" } else { "" })
        };
        let text = format!("{header}\n{goal}\n{capsule_text}\n{inbox_text}");
        let metrics = json!({
            "budget_bytes": budget,
            "total_bytes": text.len(),
            "sections": {"header": header.len(), "goal": goal.len(), "capsule": capsule_text.len(), "inbox": inbox_text.len()},
            "capsule_items_dropped": capsule.dropped,
            "dependencies": capsule.dependencies,
            "inbox_items": shown,
            "inbox_truncated": inbox_truncated,
            "estimated_tokens": text.len() / 4,
            "measured_tokens": Value::Null,
        });
        Ok(Ok(Prompt { text, metrics }))
    })
}
