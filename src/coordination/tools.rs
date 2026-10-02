//! Host-bound coordination tools exposed through the `hivemind-tool` fence.
//! Identity, room, task, attempt, and budget come from Hivemind; arguments
//! never carry them. Unavailable tools are neither offered nor executable.
use std::{path::Path, process::Command, sync::Arc};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use super::{
    model::*,
    policy::Plan,
    service::{
        ArtifactIn, CoordinationService, CreateGroup, Delegate, ResultIn, SendMessage, ToolCtx,
    },
    store::TaskFilter,
};
use crate::{access::Audit, conversation::ToolHost};

/// Coordination actions an agent may take before a plain-text answer is required.
const MAX_ACTIONS: usize = 24;
const MAX_OUTPUT: usize = 3500;

pub struct CoordinationTools {
    service: Arc<CoordinationService>,
    audit: Arc<Audit>,
}

impl CoordinationTools {
    pub fn new(service: Arc<CoordinationService>, audit: Arc<Audit>) -> Self {
        Self { service, audit }
    }
}

/// Tools whose authorization is recorded in the access audit log.
const AUDITED: &[&str] = &[
    "tasks.plan.propose",
    "tasks.delegate",
    "tasks.decide",
    "tasks.result.submit",
    "tasks.review",
    "tasks.block",
    "groups.create",
    "groups.members.update",
];

const COMMON: &[&str] = &[
    "agents.list",
    "messages.send",
    "messages.inbox",
    "messages.ack",
    "wakeup.schedule",
    "tasks.get",
    "tasks.list",
    "tasks.progress",
    "artifacts.get",
    "context.lookup",
];

/// Tool names this attempt may call, derived from its kind and the persona's permissions.
fn allowed(service: &CoordinationService, ctx: &ToolCtx) -> Vec<&'static str> {
    let mut names: Vec<&'static str> = COMMON.to_vec();
    let roster = service.roster();
    let persona = roster.get(&ctx.persona);
    let can = |permission: &str| persona.is_some_and(|p| p.has_permission(permission));
    let coordinator = service
        .store()
        .read(|db| Ok(db.task_or_err(&ctx.root_id)?.coordinator == ctx.persona))
        .unwrap_or(false);
    // `coordinate` implies `delegate`, `group.manage`, and `task.reassign` (see access::IMPLIES).
    let delegating = can("delegate") || can("task.reassign") || coordinator;
    let grouping = can("group.manage") || coordinator;
    match ctx.kind {
        AttemptKind::Plan => names.extend(["tasks.plan.propose", "tasks.block", "tasks.decide"]),
        AttemptKind::Work => names.extend(["tasks.result.submit", "tasks.block"]),
        AttemptKind::Review => names.extend(["tasks.review"]),
        AttemptKind::Inbox => {}
    }
    if ctx.kind != AttemptKind::Review {
        if delegating {
            names.push("tasks.delegate");
        }
        if grouping {
            names.extend(["groups.create", "groups.get", "groups.members.update"]);
        }
    }
    if (coordinator || can("task.decide"))
        && matches!(ctx.kind, AttemptKind::Review | AttemptKind::Inbox)
    {
        names.push("tasks.decide");
    }
    if grouping && ctx.kind == AttemptKind::Review {
        names.extend(["groups.get"]);
    }
    names.sort_unstable();
    names.dedup();
    names
}

fn role_line(kind: AttemptKind) -> &'static str {
    match kind {
        AttemptKind::Plan => "You are the COORDINATOR planning this root task: propose a task graph with tasks.plan.propose (it commits immediately but does not run the work).",
        AttemptKind::Work => "You are the OWNER of this task: do the work, then call tasks.result.submit with artifacts and verification evidence. Submitting does not complete the task; a reviewer decides.",
        AttemptKind::Review => "You are the REVIEWER of this task: check the submitted result against the acceptance criteria and call tasks.review with approve or reject.",
        AttemptKind::Inbox => "You were woken by messages addressed to you. Handle them, reply with messages.send if needed, and acknowledge with messages.ack.",
    }
}

const EXAMPLES: &[(&str, &str)] = &[
    ("agents.list", r#"{"capability":"backend"}"#),
    (
        "messages.send",
        r#"{"to":["Backend"],"kind":"request","body":"Which error shape does POST /orders return?"}"#,
    ),
    ("messages.inbox", r#"{"limit":5}"#),
    ("messages.ack", r#"{"id":"mg_..."}"#),
    (
        "wakeup.schedule",
        r#"{"delay_seconds":600,"context":"re-check whether the API contract was answered"}"#,
    ),
    (
        "groups.create",
        r#"{"purpose":"orders form contract","roles":["frontend","backend"]}"#,
    ),
    ("groups.get", r#"{"id":"gr_..."}"#),
    (
        "groups.members.update",
        r#"{"id":"gr_...","add":["Reviewer"],"expected_revision":1}"#,
    ),
    ("tasks.get", r#"{"id":"tk_..."}"#),
    ("tasks.list", r#"{"status":"ready","limit":10}"#),
    (
        "tasks.plan.propose",
        r#"{"tasks":[{"key":"api","objective":"...","acceptance":["..."],"capabilities":["backend"],"contract":"POST /orders -> 201 {id}"},{"key":"ui","objective":"...","acceptance":["..."],"capabilities":["frontend"],"depends_on":["api"]}]}"#,
    ),
    (
        "tasks.delegate",
        r#"{"objective":"...","acceptance":["..."],"capabilities":["backend"]}"#,
    ),
    (
        "tasks.progress",
        r#"{"note":"schema migrated, wiring handler"}"#,
    ),
    (
        "tasks.block",
        r#"{"reason":"need the staging URL","needs_input":true}"#,
    ),
    (
        "tasks.result.submit",
        r#"{"summary":"...","artifacts":[{"kind":"file","reference":"src/orders.rs","description":"validation"}],"verification":[{"check":"cargo test","outcome":"passed","detail":"41 passed"}]}"#,
    ),
    (
        "tasks.review",
        r#"{"verdict":"approve","notes":"criteria met"}"#,
    ),
    ("tasks.decide", r#"{"id":"dc_...","verdict":"accept"}"#),
    (
        "artifacts.get",
        r#"{"id":"ar_...","offset":0,"limit":3000}"#,
    ),
    ("context.lookup", r#"{"kind":"message","id":"mg_..."}"#),
];

impl ToolHost for CoordinationTools {
    fn manifest(&self, room: &str, persona: &str) -> Option<String> {
        let ctx = self.service.bind(room, persona).ok().flatten()?;
        let names = allowed(&self.service, &ctx);
        let usage = self
            .service
            .store()
            .read(|db| db.usage(&ctx.root_id))
            .ok()
            .flatten();
        let budget = usage
            .map(|u| {
                format!(
                    "Remaining root budget: {} dispatches, {} tool actions, {} messages, {}s.",
                    u.dispatch_limit.saturating_sub(u.dispatches),
                    u.tool_action_limit.saturating_sub(u.tool_actions),
                    u.message_limit.saturating_sub(u.messages),
                    (u.deadline - self.service.store().now()).max(0)
                )
            })
            .unwrap_or_default();
        let examples = EXAMPLES
            .iter()
            .filter(|(name, _)| names.contains(name))
            .map(|(name, args)| format!("{{\"name\":\"{name}\",\"args\":{args}}}"))
            .collect::<Vec<_>>()
            .join("\n");
        Some(format!(
            "Hivemind coordination tools (same ```hivemind-tool fence as memory tools; one call per reply as your whole reply):\n{}\nTask {} (root {}). {budget}\nTools you may call: {}\nExamples:\n{examples}\nRules: a message only queues work for the recipient — it does not run them now. Hivemind binds every call to your identity, task, and lease; never send ids of yours. Messages, groups, and artifacts are shared content: put nothing private in them. Never invent results.\n",
            role_line(ctx.kind),
            ctx.task_id,
            ctx.root_id,
            names.join(", "),
        ))
    }

    fn reminder(&self, room: &str, persona: &str) -> Option<String> {
        let ctx = self.service.bind(room, persona).ok().flatten()?;
        Some(format!("Hivemind coordination tools remain available as described at the start of this session ({} on task {}).\n", ctx.kind.as_str(), ctx.task_id))
    }

    fn max_actions(&self, room: &str) -> usize {
        if task_of_room(room).is_some() {
            MAX_ACTIONS
        } else {
            4
        }
    }

    fn agent_originated(&self, room: &str) -> bool {
        self.service.enabled() && task_of_room(room).is_some()
    }

    fn handles(&self, name: &str) -> bool {
        EXAMPLES.iter().any(|(known, _)| *known == name)
    }

    fn execute(&self, room: &str, persona: &str, name: &str, args: &Value) -> Result<String> {
        let ctx = self
            .service
            .bind(room, persona)
            .map_err(|e| anyhow::anyhow!("{e}"))?
            .context("coordination tools are only available during a task attempt")?;
        let audited = AUDITED.contains(&name);
        let permission = crate::access::coordination_permission(name, args).unwrap_or("");
        let resource = format!("task:{}", ctx.task_id);
        if !allowed(&self.service, &ctx).contains(&name) {
            if audited {
                self.audit.record(
                    persona,
                    permission,
                    name,
                    &resource,
                    false,
                    &format!("tool not available to a {} attempt", ctx.kind.as_str()),
                );
            }
            bail!("tool '{name}' is not available to you in this attempt");
        }
        let result = run(&self.service, &ctx, name, args);
        if audited {
            match &result {
                Ok(_) => {
                    self.audit
                        .record(persona, permission, name, &resource, true, "authorized")
                }
                Err(CoordError::Forbidden(reason)) => self
                    .audit
                    .record(persona, permission, name, &resource, false, reason),
                Err(error) => self.audit.record(
                    persona,
                    permission,
                    name,
                    &resource,
                    true,
                    &format!("authorized; failed: {error}"),
                ),
            }
        }
        result.map_err(|e| anyhow::anyhow!("{e}"))
    }
}

fn str_arg(args: &Value, key: &str) -> CoordResult<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| CoordError::Invalid(format!("argument '{key}' must be a non-empty string")))
}

fn opt_str(args: &Value, key: &str) -> CoordResult<Option<String>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(Some(s.trim().to_owned())),
        Some(_) => Err(CoordError::Invalid(format!(
            "argument '{key}' must be a non-empty string"
        ))),
    }
}

fn str_list(args: &Value, key: &str, max: usize) -> CoordResult<Vec<String>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) if items.len() <= max => items
            .iter()
            .map(|i| {
                i.as_str().map(|s| s.trim().to_owned()).ok_or_else(|| {
                    CoordError::Invalid(format!("'{key}' must be an array of strings"))
                })
            })
            .collect(),
        Some(_) => Err(CoordError::Invalid(format!(
            "'{key}' must be an array of at most {max} strings"
        ))),
    }
}

fn opt_int(args: &Value, key: &str) -> CoordResult<Option<i64>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_i64()
            .map(Some)
            .ok_or_else(|| CoordError::Invalid(format!("argument '{key}' must be an integer"))),
    }
}

fn opt_bool(args: &Value, key: &str) -> CoordResult<bool> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(v) => v
            .as_bool()
            .ok_or_else(|| CoordError::Invalid(format!("argument '{key}' must be a boolean"))),
    }
}

fn bounded(text: String) -> String {
    if text.len() <= MAX_OUTPUT {
        return text;
    }
    format!(
        "{}…[truncated; use artifacts.get or context.lookup for exact records]",
        clip(&text, MAX_OUTPUT)
    )
}

fn task_line(t: &Task) -> String {
    format!(
        "- {} [{}] owner={} reviewer={} rev={} — {}{}",
        t.id,
        t.status.as_str(),
        t.owner.as_deref().unwrap_or("-"),
        t.reviewer.as_deref().unwrap_or("-"),
        t.revision,
        clip(&t.objective, 160),
        t.status_reason
            .as_deref()
            .map(|r| format!(" ({r})"))
            .unwrap_or_default()
    )
}

/// Render a handoff into one bounded, schema-shaped message body.
fn handoff_body(args: &Value) -> CoordResult<(String, Vec<String>)> {
    let h = args.get("handoff").filter(|v| v.is_object()).ok_or_else(|| CoordError::Invalid("kind handoff needs a 'handoff' object with changes, contract, artifacts, verification, blockers, requested_action".into()))?;
    let field = |key: &str| -> CoordResult<String> {
        Ok(clip(
            h.get(key).and_then(Value::as_str).unwrap_or("").trim(),
            1200,
        )
        .to_owned())
    };
    let artifacts = str_list(h, "artifacts", 8)?;
    let (changes, contract, verification, blockers, requested) = (
        field("changes")?,
        field("contract")?,
        field("verification")?,
        field("blockers")?,
        field("requested_action")?,
    );
    if changes.is_empty() && contract.is_empty() && requested.is_empty() {
        return Err(CoordError::Invalid(
            "a handoff needs at least changes, contract, or requested_action".into(),
        ));
    }
    let body = format!("Handoff\nChanges: {changes}\nContract: {contract}\nArtifacts: {}\nVerification: {verification}\nBlockers: {blockers}\nRequested action: {requested}", artifacts.join(", "));
    Ok((body, artifacts))
}

fn run(
    service: &CoordinationService,
    ctx: &ToolCtx,
    name: &str,
    args: &Value,
) -> CoordResult<String> {
    match name {
        "agents.list" => {
            service.live(ctx)?;
            let capability = opt_str(args, "capability")?.map(|c| super::policy::normalize_tag(&c));
            let root = service.store().read(|db| db.task_or_err(&ctx.root_id))?;
            let activity = service.activity()?;
            let lines: Vec<String> = service
                .roster()
                .personas()
                .iter()
                .filter(|p| Roster_eligible(p, &root.workspace))
                .filter(|p| {
                    capability
                        .as_ref()
                        .is_none_or(|c| p.capabilities.contains(c))
                })
                .take(24)
                .map(|p| {
                    format!(
                        "- {} caps=[{}] permissions=[{}] state={}",
                        p.name,
                        p.capabilities.join(","),
                        p.permissions.join(","),
                        activity
                            .iter()
                            .find(|a| a.persona == p.name)
                            .map(|a| a.state.as_str())
                            .unwrap_or("idle")
                    )
                })
                .collect();
            Ok(if lines.is_empty() {
                "no matching personas".into()
            } else {
                bounded(lines.join("\n"))
            })
        }
        "messages.send" => {
            let kind = MessageKind::parse(&str_arg(args, "kind")?).ok_or_else(|| {
                CoordError::Invalid(
                    "kind must be request, handoff, status, decision_proposal, or ack".into(),
                )
            })?;
            let (body, mut artifacts) = if kind == MessageKind::Handoff {
                handoff_body(args)?
            } else {
                (str_arg(args, "body")?, Vec::new())
            };
            for id in str_list(args, "artifacts", 8)? {
                if !artifacts.contains(&id) {
                    artifacts.push(id);
                }
            }
            let (message, duplicate) = service.send_message(
                ctx,
                SendMessage {
                    recipients: str_list(args, "to", 8)?,
                    group: opt_str(args, "group")?,
                    kind,
                    body,
                    artifacts,
                    causation: opt_str(args, "causation")?,
                    idempotency_key: opt_str(args, "key")?,
                },
            )?;
            Ok(format!("{} message {} to [{}]: queued for delivery; recipients act on it when Hivemind schedules them, not now", if duplicate { "already sent" } else { "sent" }, message.id, message.recipients.join(", ")))
        }
        "messages.inbox" => {
            let limit = opt_int(args, "limit")?.unwrap_or(5).clamp(1, 8) as usize;
            let items = service.inbox(ctx, limit)?;
            if items.is_empty() {
                return Ok("inbox is empty".into());
            }
            Ok(bounded(
                items
                    .iter()
                    .map(|(d, m)| {
                        format!(
                            "- {} [{}] from {} ({}, state {}): {}",
                            m.id,
                            m.kind.as_str(),
                            m.sender,
                            m.task_id,
                            d.state.as_str(),
                            clip(&m.body, 900)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            ))
        }
        "wakeup.schedule" => {
            let delay = opt_int(args, "delay_seconds")?
                .ok_or_else(|| CoordError::Invalid("missing argument 'delay_seconds'".into()))?;
            let (message, duplicate) = service.schedule_wakeup(
                ctx,
                delay,
                &str_arg(args, "context")?,
                opt_str(args, "key")?.as_deref(),
            )?;
            Ok(format!(
                "{} wakeup {}: Hivemind will wake you with your context in {delay}s (once)",
                if duplicate {
                    "already scheduled"
                } else {
                    "scheduled"
                },
                message.id
            ))
        }
        "messages.ack" => {
            service.ack(ctx, &str_arg(args, "id")?)?;
            Ok("acknowledged".into())
        }
        "groups.create" => {
            let (group, existing) = service.create_group(
                ctx,
                CreateGroup {
                    purpose: str_arg(args, "purpose")?,
                    roles: str_list(args, "roles", 8)?,
                    members: str_list(args, "members", 8)?,
                },
            )?;
            Ok(format!(
                "{} group {} (revision {}) members: {}",
                if existing { "reused" } else { "created" },
                group.id,
                group.revision,
                group
                    .members
                    .iter()
                    .map(|m| format!("{}({})", m.persona, m.role))
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        }
        "groups.get" => {
            let group = service.get_group(ctx, &str_arg(args, "id")?)?;
            Ok(format!(
                "group {} purpose '{}' revision {} active={} members: {}",
                group.id,
                group.purpose,
                group.revision,
                group.active,
                group
                    .members
                    .iter()
                    .map(|m| format!("{}({})", m.persona, m.role))
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        }
        "groups.members.update" => {
            let group = service.update_members(
                ctx,
                &str_arg(args, "id")?,
                &str_list(args, "add", 8)?,
                &str_list(args, "remove", 8)?,
                opt_int(args, "expected_revision")?,
            )?;
            Ok(format!(
                "group {} now revision {} members: {}",
                group.id,
                group.revision,
                group
                    .members
                    .iter()
                    .map(|m| m.persona.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        }
        "tasks.get" => {
            service.live(ctx)?;
            let id = opt_str(args, "id")?.unwrap_or_else(|| ctx.task_id.clone());
            let detail = service.detail(&id)?;
            if detail.task.root_id != ctx.root_id {
                return Err(CoordError::Forbidden(
                    "task belongs to a different root task".into(),
                ));
            }
            let mut out = vec![
                task_line(&detail.task),
                format!("  acceptance: {}", detail.task.acceptance.join(" | ")),
            ];
            out.extend(detail.children.iter().map(|c| {
                format!(
                    "  child {} [{}] owner={} — {}",
                    c.id,
                    c.status.as_str(),
                    c.owner.as_deref().unwrap_or("-"),
                    clip(&c.objective, 120)
                )
            }));
            out.extend(detail.artifacts.iter().map(|a| {
                format!(
                    "  artifact {} [{}] {}",
                    a.id,
                    a.kind,
                    clip(&a.reference, 120)
                )
            }));
            Ok(bounded(out.join("\n")))
        }
        "tasks.list" => {
            service.live(ctx)?;
            let status = opt_str(args, "status")?
                .map(|s| {
                    TaskStatus::parse(&s)
                        .ok_or_else(|| CoordError::Invalid(format!("unknown status '{s}'")))
                })
                .transpose()?;
            let limit = opt_int(args, "limit")?.unwrap_or(10).clamp(1, 25) as usize;
            let tasks = service.list_tasks(&TaskFilter {
                root: Some(&ctx.root_id),
                status,
                limit,
                ..Default::default()
            })?;
            Ok(if tasks.is_empty() {
                "no tasks".into()
            } else {
                bounded(tasks.iter().map(task_line).collect::<Vec<_>>().join("\n"))
            })
        }
        "tasks.plan.propose" => {
            let plan: Plan = serde_json::from_value(
                json!({"tasks": args.get("tasks").cloned().unwrap_or(Value::Null)}),
            )
            .map_err(|e| CoordError::Invalid(format!("invalid plan: {e}")))?;
            let ids = service.propose_plan(ctx, &plan, opt_int(args, "expected_revision")?)?;
            Ok(format!(
                "plan committed: {} — tasks are queued; nothing has run yet",
                ids.iter()
                    .map(|(k, id)| format!("{k}={id}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        }
        "tasks.delegate" => {
            if let Some(target) = opt_str(args, "task")? {
                service.reassign(
                    ctx,
                    &target,
                    &str_arg(args, "owner")?,
                    opt_int(args, "expected_revision")?,
                )?;
                return Ok(format!("task {target} reassigned"));
            }
            let id = service.delegate(
                ctx,
                Delegate {
                    objective: str_arg(args, "objective")?,
                    acceptance: str_list(args, "acceptance", 12)?,
                    capabilities: str_list(args, "capabilities", 8)?,
                    owner: opt_str(args, "owner")?,
                    reviewer: opt_str(args, "reviewer")?,
                    depends_on: str_list(args, "depends_on", 8)?,
                },
            )?;
            Ok(format!(
                "delegated as task {id}; it is queued and has not started"
            ))
        }
        "tasks.progress" => {
            service.progress(ctx, &str_arg(args, "note")?)?;
            Ok("progress recorded".into())
        }
        "tasks.block" => {
            service.block(
                ctx,
                &str_arg(args, "reason")?,
                opt_bool(args, "needs_input")?,
            )?;
            Ok("task marked blocked; end your reply now".into())
        }
        "tasks.result.submit" => {
            let artifacts = match args.get("artifacts") {
                None | Some(Value::Null) => Vec::new(),
                Some(Value::Array(items)) => items
                    .iter()
                    .map(|a| {
                        Ok(ArtifactIn {
                            kind: str_arg(a, "kind")?,
                            reference: str_arg(a, "reference")?,
                            description: opt_str(a, "description")?.unwrap_or_default(),
                        })
                    })
                    .collect::<CoordResult<Vec<_>>>()?,
                Some(_) => return Err(CoordError::Invalid("'artifacts' must be an array".into())),
            };
            let verification = match args.get("verification") {
                Some(Value::Array(items)) => items
                    .iter()
                    .map(|v| {
                        let outcome = Verdict::parse(&str_arg(v, "outcome")?).ok_or_else(|| {
                            CoordError::Invalid(
                                "outcome must be passed, failed, or unavailable".into(),
                            )
                        })?;
                        Ok(Evidence {
                            check: str_arg(v, "check")?,
                            outcome,
                            detail: opt_str(v, "detail")?.unwrap_or_default(),
                        })
                    })
                    .collect::<CoordResult<Vec<_>>>()?,
                _ => {
                    return Err(CoordError::Invalid(
                        "'verification' must be a non-empty array".into(),
                    ))
                }
            };
            service.submit_result(
                ctx,
                ResultIn {
                    summary: str_arg(args, "summary")?,
                    artifacts,
                    verification,
                },
            )?;
            Ok("result submitted for review; the task is not complete until a reviewer approves it. End your reply now".into())
        }
        "tasks.review" => {
            let approve = match str_arg(args, "verdict")?.as_str() {
                "approve" => true,
                "reject" => false,
                _ => {
                    return Err(CoordError::Invalid(
                        "verdict must be approve or reject".into(),
                    ))
                }
            };
            let status = service.review(
                ctx,
                approve,
                opt_str(args, "notes")?.as_deref().unwrap_or(""),
            )?;
            Ok(format!("verdict recorded; task is now {}", status.as_str()))
        }
        "tasks.decide" => {
            let accept = match str_arg(args, "verdict")?.as_str() {
                "accept" => true,
                "reject" => false,
                _ => {
                    return Err(CoordError::Invalid(
                        "verdict must be accept or reject".into(),
                    ))
                }
            };
            service.decide(ctx, &str_arg(args, "id")?, accept)?;
            Ok("decision recorded".into())
        }
        "artifacts.get" => artifact_get(service, ctx, args),
        "context.lookup" => lookup(service, ctx, args),
        other => Err(CoordError::Invalid(format!(
            "unknown coordination tool '{other}'"
        ))),
    }
}

#[allow(non_snake_case)]
fn Roster_eligible(persona: &super::policy::Persona, workspace: &str) -> bool {
    super::policy::Roster::eligible_for_workspace(persona, workspace)
}

fn window(text: &[u8], offset: usize, limit: usize) -> String {
    let start = offset.min(text.len());
    let end = (start + limit).min(text.len());
    let chunk = String::from_utf8_lossy(&text[start..end]).into_owned();
    if end < text.len() {
        format!(
            "{chunk}\n…[bytes {start}-{end} of {}; call again with offset {end}]",
            text.len()
        )
    } else {
        format!("{chunk}\n[bytes {start}-{end} of {}: end]", text.len())
    }
}

/// Hard cap on `git show` bytes read for one artifact; the child is killed past it,
/// so a huge commit can neither stall a worker nor fill memory.
const MAX_SHOW_BYTES: u64 = 1 << 20;

fn bounded_git_show(workspace: &str, sha: &str) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut child = Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(["show", "--stat", "--patch", "--no-color", sha])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let mut out = Vec::new();
    child
        .stdout
        .take()?
        .take(MAX_SHOW_BYTES)
        .read_to_end(&mut out)
        .ok()?;
    let truncated = out.len() as u64 >= MAX_SHOW_BYTES;
    if truncated {
        let _ = child.kill();
    }
    let status = child.wait().ok()?;
    (truncated || status.success()).then_some(out)
}

fn artifact_get(service: &CoordinationService, ctx: &ToolCtx, args: &Value) -> CoordResult<String> {
    service.live(ctx)?;
    let id = str_arg(args, "id")?;
    let offset = opt_int(args, "offset")?.unwrap_or(0).max(0) as usize;
    let limit = opt_int(args, "limit")?.unwrap_or(3000).clamp(1, 3500) as usize;
    let (artifact, task, worktree) = service.store().read(|db| {
        let artifact = db
            .artifact(&id)?
            .ok_or_else(|| CoordError::NotFound(format!("artifact '{id}' was not found")))?;
        let task = db.task_or_err(&artifact.task_id)?;
        let worktree = artifact
            .attempt_id
            .as_deref()
            .map(|a| db.attempt(a))
            .transpose()?
            .flatten()
            .and_then(|a| a.worktree);
        Ok((artifact, task, worktree))
    })?;
    if task.root_id != ctx.root_id {
        return Err(CoordError::Forbidden(
            "artifact belongs to a different root task".into(),
        ));
    }
    match artifact.kind.as_str() {
        "commit" => {
            let sha = artifact
                .content_hash
                .clone()
                .ok_or_else(|| CoordError::Internal("commit artifact has no hash".into()))?;
            let out = bounded_git_show(&task.workspace, &sha)
                .ok_or_else(|| CoordError::NotFound("commit is no longer available".into()))?;
            Ok(window(&out, offset, limit))
        }
        "file" => {
            let base = std::fs::canonicalize(worktree.as_deref().unwrap_or(&task.workspace))
                .map_err(|e| CoordError::NotFound(format!("workspace unavailable: {e}")))?;
            let path = std::fs::canonicalize(base.join(artifact.reference.trim_start_matches('/')))
                .map_err(|_| CoordError::NotFound("file no longer exists".into()))?;
            if !path.starts_with(&base) || !Path::new(&path).is_file() {
                return Err(CoordError::Forbidden(
                    "artifact path escapes the task workspace".into(),
                ));
            }
            let bytes = std::fs::read(&path)
                .map_err(|e| CoordError::Internal(format!("reading artifact: {e}")))?;
            Ok(window(&bytes, offset, limit))
        }
        _ => Ok(window(
            format!(
                "{} [{}] {}\n{}",
                artifact.id, artifact.kind, artifact.reference, artifact.description
            )
            .as_bytes(),
            offset,
            limit,
        )),
    }
}

fn lookup(service: &CoordinationService, ctx: &ToolCtx, args: &Value) -> CoordResult<String> {
    service.live(ctx)?;
    let kind = str_arg(args, "kind")?;
    let id = str_arg(args, "id")?;
    let denied = || CoordError::Forbidden("record is outside your access".into());
    let value = service.store().read(|db| match kind.as_str() {
        "task" => {
            let task = db.task_or_err(&id)?;
            if task.root_id != ctx.root_id {
                return Err(denied());
            }
            Ok(json!({"task": task, "evidence": db.latest_evidence(&id)?, "decisions": db.decisions(&id, Some("accepted"))?}))
        }
        "message" => {
            let m = db.message(&id)?.ok_or_else(|| CoordError::NotFound(format!("message '{id}' was not found")))?;
            let party = m.sender == ctx.persona || m.recipients.contains(&ctx.persona) || m.group_id.as_deref().is_some_and(|g| db.is_member(g, &ctx.persona).unwrap_or(false));
            if m.root_id != ctx.root_id || !party {
                return Err(denied());
            }
            Ok(json!(m))
        }
        "decision" => {
            let d = db.decision(&id)?.ok_or_else(|| CoordError::NotFound(format!("decision '{id}' was not found")))?;
            if db.task_or_err(&d.task_id)?.root_id != ctx.root_id {
                return Err(denied());
            }
            Ok(json!(d))
        }
        "group" => {
            let g = db.group(&id)?.ok_or_else(|| CoordError::NotFound(format!("group '{id}' was not found")))?;
            if g.root_id != ctx.root_id || !db.is_member(&id, &ctx.persona)? {
                return Err(denied());
            }
            Ok(json!(g))
        }
        "attempt" => {
            let a = db.attempt(&id)?.ok_or_else(|| CoordError::NotFound(format!("attempt '{id}' was not found")))?;
            if db.task_or_err(&a.task_id)?.root_id != ctx.root_id {
                return Err(denied());
            }
            Ok(json!(a))
        }
        _ => Err(CoordError::Invalid("kind must be task, message, decision, group, or attempt".into())),
    })?;
    Ok(bounded(serde_json::to_string(&value).unwrap_or_default()))
}
