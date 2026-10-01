//! Deterministic coordination: submission, plan commit, dispatch claims,
//! attempt outcomes, review, cancellation, messaging, and groups. Nothing
//! here contacts a model or runtime; execution is the scheduler's job.
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::Notify;

use super::{
    model::*,
    policy::{normalize_tag, validate_plan, Plan, PlanContext, ResolvedTask, Roster},
    store::{Charge, Charged, CoordinationStore, Db, NewMessage, NewTask, TaskFilter},
};
use crate::{
    config::CoordinationConfig,
    events::{DomainEventKind, EventBus},
    identity::AgentInstanceId,
};

/// Public event types, in the order the wire protocol reserves them.
pub const EVENT_TYPES: &[&str] = &[
    "task.created",
    "task.status_changed",
    "task.plan_committed",
    "task.progress",
    "task.paused",
    "task.resumed",
    "task.reassigned",
    "task.result_submitted",
    "task.decision",
    "attempt.started",
    "attempt.finished",
    "message.sent",
    "message.delivery_changed",
    "group.created",
    "group.members_changed",
    "agent.activity.changed",
    "task.steered",
    "task.question",
    "task.answered",
    "task.question_expired",
];

pub fn wire_type(event_type: &str) -> &'static str {
    EVENT_TYPES
        .iter()
        .copied()
        .find(|known| *known == event_type)
        .unwrap_or("coordination.event")
}

/// Host-bound invocation context for one live attempt. Built by Hivemind from
/// the room and persona it is executing; never from model-supplied arguments.
#[derive(Debug, Clone)]
pub struct ToolCtx {
    pub persona: String,
    pub room: String,
    pub task_id: String,
    pub root_id: String,
    pub attempt_id: String,
    pub fencing: i64,
    pub kind: AttemptKind,
}

pub struct SubmitTask {
    pub objective: String,
    pub acceptance: Vec<String>,
    pub capabilities: Vec<String>,
    pub workspace: Option<String>,
    pub plan: Option<Plan>,
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskDetail {
    pub task: Task,
    pub children: Vec<TaskSummary>,
    pub progress: HashMap<String, u32>,
    pub artifacts: Vec<Artifact>,
    pub evidence: Vec<Evidence>,
    pub groups: Vec<Group>,
    pub usage: Option<Usage>,
    /// Questions running attempts on this task are waiting on (`tasks.ask`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub questions: Vec<super::live::OpenQuestion>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskSummary {
    pub id: String,
    pub objective: String,
    pub owner: Option<String>,
    pub reviewer: Option<String>,
    pub status: TaskStatus,
    pub status_reason: Option<String>,
    pub prerequisites: Vec<String>,
}

pub struct ArtifactIn {
    pub kind: String,
    pub reference: String,
    pub description: String,
}

pub struct ResultIn {
    pub summary: String,
    pub artifacts: Vec<ArtifactIn>,
    pub verification: Vec<Evidence>,
}

pub struct SendMessage {
    pub recipients: Vec<String>,
    pub group: Option<String>,
    pub kind: MessageKind,
    pub body: String,
    pub artifacts: Vec<String>,
    pub causation: Option<String>,
    pub idempotency_key: Option<String>,
}

pub struct CreateGroup {
    pub purpose: String,
    /// Capability tags; one distinct eligible persona is chosen per tag.
    pub roles: Vec<String>,
    pub members: Vec<String>,
}

pub struct Delegate {
    pub objective: String,
    pub acceptance: Vec<String>,
    pub capabilities: Vec<String>,
    pub owner: Option<String>,
    pub reviewer: Option<String>,
    pub depends_on: Vec<String>,
}

/// A claimed unit of execution handed to the scheduler.
#[derive(Debug, Clone)]
pub struct Dispatch {
    pub attempt: Attempt,
    pub task: Task,
    pub deliveries: Vec<(Delivery, Message)>,
}

#[derive(Debug, Clone)]
pub enum AttemptEnd {
    Completed,
    Failed { class: String, detail: String },
    Cancelled,
    Interrupted,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentActivity {
    pub persona: String,
    /// idle, queued, planning, working, waiting, reviewing, failed, offline
    pub state: String,
    pub running: Vec<ActivityRef>,
    pub queued_wakes: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivityRef {
    pub instance_id: String,
    pub room_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub kind: AttemptKind,
}

pub struct CoordinationService {
    execution: std::sync::OnceLock<Arc<crate::execution::ExecutionStore>>,
    store: CoordinationStore,
    config: CoordinationConfig,
    roster_lock: std::sync::RwLock<Arc<Roster>>,
    events: EventBus,
    wake: Arc<Notify>,
    rotations: Mutex<Vec<(AgentInstanceId, &'static str)>>,
    scheduler_running: AtomicBool,
    publish: AtomicBool,
    channel: super::live::LiveChannel,
}

fn invalid<T>(message: impl Into<String>) -> CoordResult<T> {
    Err(CoordError::Invalid(message.into()))
}
fn forbid<T>(message: impl Into<String>) -> CoordResult<T> {
    Err(CoordError::Forbidden(message.into()))
}
fn conflict<T>(message: impl Into<String>) -> CoordResult<T> {
    Err(CoordError::Conflict(message.into()))
}

impl CoordinationService {
    pub fn set_execution(&self, store: Arc<crate::execution::ExecutionStore>) {
        let _ = self.execution.set(store);
    }
    pub fn new(
        store: CoordinationStore,
        config: CoordinationConfig,
        roster: Roster,
        events: EventBus,
    ) -> Self {
        Self {
            execution: std::sync::OnceLock::new(),
            store,
            config,
            roster_lock: std::sync::RwLock::new(Arc::new(roster)),
            events,
            wake: Arc::new(Notify::new()),
            rotations: Mutex::new(Vec::new()),
            scheduler_running: AtomicBool::new(false),
            publish: AtomicBool::new(true),
            channel: Default::default(),
        }
    }

    pub fn store(&self) -> &CoordinationStore {
        &self.store
    }
    pub fn config(&self) -> &CoordinationConfig {
        &self.config
    }
    /// Snapshot of the personas tasks can be assigned to.
    pub fn roster(&self) -> Arc<Roster> {
        self.roster_lock
            .read()
            .expect("roster lock poisoned")
            .clone()
    }
    /// Replace the roster after personas were created, changed, or deleted.
    pub fn set_roster(&self, roster: Roster) {
        *self.roster_lock.write().expect("roster lock poisoned") = Arc::new(roster);
    }
    pub fn enabled(&self) -> bool {
        self.config.enabled
    }
    pub fn wake_signal(&self) -> Arc<Notify> {
        self.wake.clone()
    }
    pub fn set_scheduler_running(&self, running: bool) {
        self.scheduler_running.store(running, Ordering::SeqCst);
    }
    pub fn take_rotations(&self) -> Vec<(AgentInstanceId, &'static str)> {
        std::mem::take(&mut *self.rotations.lock())
    }
    fn require_enabled(&self) -> CoordResult<()> {
        if self.config.enabled {
            Ok(())
        } else {
            Err(CoordError::Disabled)
        }
    }

    /// Hand committed-but-unpublished events to the process-local bus.
    /// One-shot CLI processes leave events unpublished for the process that
    /// serves them (its scheduler flushes on every pass).
    pub fn set_publish(&self, publish: bool) {
        self.publish.store(publish, Ordering::SeqCst);
    }

    pub fn flush(&self) {
        if !self.publish.load(Ordering::SeqCst) {
            return;
        }
        loop {
            let batch = self.store.write(|db| {
                let batch = db.unpublished_events(256)?;
                if let Some(last) = batch.last() {
                    db.mark_published(last.seq)?;
                }
                Ok(batch)
            });
            let Ok(batch) = batch else { return };
            let done = batch.len() < 256;
            for event in batch {
                self.events.publish(DomainEventKind::Coordination {
                    seq: event.seq,
                    root_id: event.root_id,
                    task_id: event.task_id,
                    event_type: event.event_type,
                    actor: event.actor,
                    payload: event.payload,
                });
            }
            if done {
                return;
            }
        }
    }

    pub(super) fn channel(&self) -> &super::live::LiveChannel {
        &self.channel
    }

    pub(super) fn changed(&self) {
        self.flush();
        self.wake.notify_waiters();
        self.wake.notify_one();
    }

    // ------------------------------------------------------------------
    // Submission and planning
    // ------------------------------------------------------------------

    pub fn submit(&self, req: SubmitTask) -> CoordResult<TaskDetail> {
        self.require_enabled()?;
        let objective = check_text("objective", &req.objective, 8000)?;
        if req.acceptance.len() > 12 {
            return invalid("at most 12 acceptance criteria");
        }
        let acceptance = req
            .acceptance
            .iter()
            .map(|c| check_text("acceptance criterion", c, 600))
            .collect::<CoordResult<Vec<_>>>()?;
        let capabilities: Vec<String> = req
            .capabilities
            .iter()
            .map(|c| normalize_tag(c))
            .filter(|c| !c.is_empty())
            .collect();
        if capabilities.len() > 8 {
            return invalid("at most 8 capabilities");
        }
        let key = req
            .idempotency_key
            .as_deref()
            .map(|k| check_text("idempotency key", k, 128))
            .transpose()?;
        let id = self.store.write(|db| {
            if let Some(key) = &key {
                if let Some(existing) = db.task_by_key(key)? {
                    return Ok(existing.id);
                }
            }
            let load = db.active_load()?;
            let workspace = match req.workspace.as_deref() {
                Some(ws) => super::policy::normalize_workspace(&check_text("workspace", ws, 1024)?),
                None => self.default_workspace(),
            };
            let coordinator = self.select_coordinator(&workspace, &load);
            let id = new_id("tk");
            db.insert_task(&NewTask {
                id: id.clone(),
                root_id: id.clone(),
                parent_id: None,
                depth: 0,
                kind: TaskKind::Work,
                objective: objective.clone(),
                acceptance,
                capabilities: capabilities.clone(),
                workspace: workspace.clone(),
                coordinator: coordinator.clone().unwrap_or_default(),
                owner: coordinator.clone(),
                reviewer: coordinator.clone(),
                status: TaskStatus::Submitted,
                reason: None,
                idempotency_key: key.clone(),
            })?;
            db.init_usage(&id, self.config.max_dispatches, self.config.max_tool_actions, self.config.max_messages, self.config.max_elapsed_secs)?;
            db.event(&id, Some(&id), "user", "task.created", serde_json::json!({"objective": clip(&objective, 200), "coordinator": coordinator}))?;
            let root = db.task_or_err(&id)?;
            let Some(coordinator) = coordinator else {
                db.set_status(&id, TaskStatus::NeedsInput, Some(&format!("no persona can coordinate in workspace '{workspace}': grant the 'coordinate' permission or set coordination.planner")), "hivemind", None)?;
                return Ok(id);
            };
            if let Some(missing) = self.missing_capabilities(&capabilities, &workspace) {
                db.set_status(&id, TaskStatus::NeedsInput, Some(&format!("no eligible persona provides capabilities [{}]", missing.join(", "))), "hivemind", None)?;
                return Ok(id);
            }
            match req.plan.as_ref() {
                Some(plan) => {
                    db.set_status(&id, TaskStatus::Planning, None, "user", None)?;
                    let root = db.task_or_err(&id)?;
                    let resolved = self.resolve_plan(db, plan, &root, &root, &coordinator)?;
                    self.commit_plan(db, &root, &root, resolved, "user")?;
                }
                None => {
                    let _ = root;
                    db.set_status(&id, TaskStatus::Planning, None, "hivemind", None)?;
                }
            }
            Ok(id)
        })?;
        self.changed();
        self.detail(&id)
    }

    fn default_workspace(&self) -> String {
        let roster = self.roster();
        let personas = roster.personas();
        let pick = self
            .config
            .planner
            .as_deref()
            .and_then(|p| roster.get(p))
            .or_else(|| personas.iter().find(|p| p.has_permission("coordinate")))
            .or_else(|| personas.first());
        pick.map(|p| p.workspace.clone())
            .unwrap_or_else(|| ".".into())
    }

    fn select_coordinator(&self, workspace: &str, load: &HashMap<String, u32>) -> Option<String> {
        if let Some(planner) = self.config.planner.as_deref() {
            let roster = self.roster();
            let persona = roster.get(planner)?;
            return Roster::eligible_for_workspace(persona, workspace)
                .then(|| persona.name.clone());
        }
        let roster = self.roster();
        roster
            .select(&[], Some("coordinate"), workspace, load, &[])
            .ok()
            .map(|p| p.name.clone())
    }

    fn missing_capabilities(&self, required: &[String], workspace: &str) -> Option<Vec<String>> {
        let missing: Vec<String> = required
            .iter()
            .filter(|cap| {
                !self.roster().personas().iter().any(|p| {
                    Roster::eligible_for_workspace(p, workspace) && p.capabilities.contains(cap)
                })
            })
            .cloned()
            .collect();
        (!missing.is_empty()).then_some(missing)
    }

    fn resolve_plan(
        &self,
        db: &Db<'_>,
        plan: &Plan,
        root: &Task,
        parent: &Task,
        coordinator: &str,
    ) -> CoordResult<Vec<ResolvedTask>> {
        let load = db.active_load()?;
        let existing: HashSet<String> = db
            .list_tasks(&TaskFilter {
                root: Some(&root.id),
                limit: 500,
                ..Default::default()
            })?
            .into_iter()
            .filter(|t| !matches!(t.status, TaskStatus::Failed | TaskStatus::Cancelled))
            .map(|t| t.id)
            .collect();
        let existing_count = db.count_tasks(&root.id)?;
        validate_plan(
            plan,
            &PlanContext {
                roster: &self.roster(),
                workspace: &root.workspace,
                coordinator,
                load: &load,
                existing: &existing,
                existing_count,
                max_tasks: self.config.max_plan_tasks,
                max_depth: self.config.max_plan_depth,
                parent_depth: parent.depth as usize,
            },
        )
    }

    fn commit_plan(
        &self,
        db: &Db<'_>,
        root: &Task,
        parent: &Task,
        resolved: Vec<ResolvedTask>,
        actor: &str,
    ) -> CoordResult<Vec<(String, String)>> {
        let contracts: HashMap<String, Option<String>> = resolved
            .iter()
            .map(|t| (t.key.clone(), t.contract.clone()))
            .collect();
        let ids: HashMap<String, String> = resolved
            .iter()
            .map(|t| (t.key.clone(), new_id("tk")))
            .collect();
        for task in &resolved {
            let id = &ids[&task.key];
            db.insert_task(&NewTask {
                id: id.clone(),
                root_id: root.id.clone(),
                parent_id: Some(parent.id.clone()),
                depth: parent.depth + 1,
                kind: task.kind,
                objective: task.objective.clone(),
                acceptance: task.acceptance.clone(),
                capabilities: task.capabilities.clone(),
                workspace: root.workspace.clone(),
                coordinator: root.coordinator.clone(),
                owner: Some(task.owner.clone()),
                reviewer: Some(task.reviewer.clone()),
                status: TaskStatus::Submitted,
                reason: None,
                idempotency_key: None,
            })?;
            for dep in &task.plan_deps {
                db.add_dependency(id, &ids[dep], contracts[dep].as_deref())?;
            }
            for dep in &task.existing_deps {
                db.add_dependency(id, dep, None)?;
            }
            db.event(&root.id, Some(id), actor, "task.created", serde_json::json!({"key": task.key, "owner": task.owner, "reviewer": task.reviewer, "depends_on": task.plan_deps.iter().map(|d| ids[d].clone()).chain(task.existing_deps.iter().cloned()).collect::<Vec<_>>()}))?;
        }
        db.event(
            &root.id,
            Some(&parent.id),
            actor,
            "task.plan_committed",
            serde_json::json!({"count": resolved.len()}),
        )?;
        let current_root = db.task_or_err(&root.id)?;
        if matches!(
            current_root.status,
            TaskStatus::Planning | TaskStatus::Submitted
        ) {
            db.set_status(&root.id, TaskStatus::Running, None, actor, None)?;
        }
        self.refresh_graph(db)?;
        Ok(resolved
            .iter()
            .map(|t| (t.key.clone(), ids[&t.key].clone()))
            .collect())
    }

    // ------------------------------------------------------------------
    // Graph maintenance
    // ------------------------------------------------------------------

    /// Promote waiting tasks, stop dependants of failed work, and move a root
    /// whose children are all complete to review. Idempotent.
    fn refresh_graph(&self, db: &Db<'_>) -> CoordResult<()> {
        for task in db.tasks_with_status(TaskStatus::Submitted, 500)? {
            if task.id == task.root_id {
                continue;
            }
            let mut all_done = true;
            let mut broken = None;
            for (pre, _) in db.prerequisites(&task.id)? {
                let pre = db.task_or_err(&pre)?;
                match pre.status {
                    TaskStatus::Completed => {}
                    TaskStatus::Failed | TaskStatus::Cancelled => {
                        broken = Some(format!("dependency {} is {}", pre.id, pre.status.as_str()));
                        break;
                    }
                    _ => all_done = false,
                }
            }
            if let Some(reason) = broken {
                db.set_status(
                    &task.id,
                    TaskStatus::Blocked,
                    Some(&reason),
                    "hivemind",
                    None,
                )?;
            } else if all_done {
                db.set_status(&task.id, TaskStatus::Ready, None, "hivemind", None)?;
            }
        }
        for root in db.tasks_with_status(TaskStatus::Running, 500)? {
            if root.id != root.root_id {
                continue;
            }
            let tasks = db.list_tasks(&TaskFilter {
                root: Some(&root.id),
                limit: 500,
                ..Default::default()
            })?;
            let others: Vec<&Task> = tasks.iter().filter(|t| t.id != root.id).collect();
            if others.is_empty() || !db.running_attempts(Some(&root.id))?.is_empty() {
                continue;
            }
            if let Some(bad) = others.iter().find(|t| t.status == TaskStatus::Failed) {
                db.set_status(
                    &root.id,
                    TaskStatus::Blocked,
                    Some(&format!(
                        "task {} failed: {}",
                        bad.id,
                        bad.status_reason.as_deref().unwrap_or("no reason recorded")
                    )),
                    "hivemind",
                    None,
                )?;
            } else if others.iter().all(|t| t.status == TaskStatus::Completed) {
                db.set_status(&root.id, TaskStatus::Review, None, "hivemind", None)?;
            }
        }
        Ok(())
    }

    pub fn refresh(&self) -> CoordResult<()> {
        self.store.write(|db| self.refresh_graph(db))?;
        self.flush();
        Ok(())
    }

    fn block_root(&self, db: &Db<'_>, root: &str, reason: &str) -> CoordResult<()> {
        let task = db.task_or_err(root)?;
        if !task.status.is_terminal()
            && task.status != TaskStatus::Blocked
            && task.status.can_transition_to(TaskStatus::Blocked)
        {
            db.set_status(root, TaskStatus::Blocked, Some(reason), "hivemind", None)?;
        }
        Ok(())
    }

    fn charge(&self, root: &str, what: Charge) -> CoordResult<()> {
        let exhausted = self.store.write(|db| match db.charge(root, what)? {
            Charged::Ok => Ok(None),
            Charged::Exhausted(reason) => {
                self.block_root(db, root, &format!("budget exhausted: {reason}"))?;
                Ok(Some(reason))
            }
        })?;
        match exhausted {
            None => Ok(()),
            Some(reason) => {
                self.changed();
                Err(CoordError::Budget(format!("budget exhausted: {reason}")))
            }
        }
    }

    // ------------------------------------------------------------------
    // Dispatch claims
    // ------------------------------------------------------------------

    /// Claim up to `capacity` executions: review, planning, ready work, then
    /// queued wakeups. `serialized` says whether a workspace needs one writer
    /// at a time; `busy` holds workspaces currently in use.
    pub fn claim(
        &self,
        capacity: usize,
        serialized: &dyn Fn(&str) -> bool,
        busy: &HashSet<String>,
    ) -> CoordResult<Vec<Dispatch>> {
        if !self.config.enabled || capacity == 0 {
            return Ok(Vec::new());
        }
        let mut busy = busy.clone();
        let claimed = self.store.write(|db| {
            self.refresh_graph(db)?;
            let mut out: Vec<Dispatch> = Vec::new();
            let mut exhausted: Vec<(String, String)> = Vec::new();
            let mut candidates: Vec<(Task, AttemptKind, String)> = Vec::new();
            for task in db.tasks_with_status(TaskStatus::Review, 200)? {
                let reviewer = task
                    .reviewer
                    .clone()
                    .filter(|r| !r.is_empty())
                    .unwrap_or_else(|| task.coordinator.clone());
                candidates.push((task, AttemptKind::Review, reviewer));
            }
            for task in db.tasks_with_status(TaskStatus::Planning, 200)? {
                if task.id == task.root_id {
                    let coordinator = task.coordinator.clone();
                    candidates.push((task, AttemptKind::Plan, coordinator));
                }
            }
            for task in db.tasks_with_status(TaskStatus::Ready, 200)? {
                if let Some(owner) = task.owner.clone() {
                    candidates.push((task, AttemptKind::Work, owner));
                }
            }
            for (task, kind, persona) in candidates {
                if out.len() >= capacity {
                    break;
                }
                let root = db.task_or_err(&task.root_id)?;
                if root.paused
                    || root.status.is_terminal()
                    || root.status == TaskStatus::Blocked && root.id != task.id
                {
                    continue;
                }
                if let Some(execution) = self.execution.get() {
                    let project = std::fs::canonicalize(&task.workspace)
                        .unwrap_or_else(|_| task.workspace.clone().into())
                        .display()
                        .to_string();
                    if let Err(error) = execution.check_budget(&task.root_id, &project) {
                        self.block_root(db, &task.root_id, &format!("usage budget: {error}"))?;
                        continue;
                    }
                }
                if task.paused || (task.id == root.id && root.paused) {
                    continue;
                }
                if !db.running_attempts(Some(&task.id))?.is_empty() {
                    continue;
                }
                if self.roster().get(&persona).is_none() {
                    db.set_status(
                        &task.id,
                        TaskStatus::Blocked,
                        Some(&format!("persona '{persona}' is not configured")),
                        "hivemind",
                        None,
                    )?;
                    continue;
                }
                let needs_serial = serialized(&task.workspace) && kind == AttemptKind::Work;
                if needs_serial && busy.contains(&task.workspace) {
                    continue;
                }
                if matches!(kind, AttemptKind::Work | AttemptKind::Plan)
                    && db.attempt_count(&task.id)? >= self.config.max_attempts_per_task
                {
                    db.set_status(
                        &task.id,
                        TaskStatus::Failed,
                        Some("attempt limit reached"),
                        "hivemind",
                        None,
                    )?;
                    continue;
                }
                match db.charge(&task.root_id, Charge::Dispatch)? {
                    Charged::Ok => {}
                    Charged::Exhausted(reason) => {
                        exhausted.push((task.root_id.clone(), reason));
                        continue;
                    }
                }
                let task = if kind == AttemptKind::Work {
                    db.set_status(&task.id, TaskStatus::Running, None, "hivemind", None)?
                } else {
                    task
                };
                let attempt = self.new_attempt(db, &task, kind, &persona)?;
                if needs_serial {
                    busy.insert(task.workspace.clone());
                }
                out.push(Dispatch {
                    attempt,
                    task,
                    deliveries: Vec::new(),
                });
            }
            if out.len() < capacity {
                type Waiting = (String, String, Vec<(Delivery, Message)>);
                let mut grouped: Vec<Waiting> = Vec::new();
                for (delivery, message) in db.wake_queue(200)? {
                    match grouped
                        .iter_mut()
                        .find(|(t, p, _)| *t == message.task_id && *p == delivery.recipient)
                    {
                        Some((_, _, items)) => items.push((delivery, message)),
                        None => grouped.push((
                            message.task_id.clone(),
                            delivery.recipient.clone(),
                            vec![(delivery, message)],
                        )),
                    }
                }
                for (task_id, persona, items) in grouped {
                    if out.len() >= capacity {
                        break;
                    }
                    let task = db.task_or_err(&task_id)?;
                    let root = db.task_or_err(&task.root_id)?;
                    if task.status.is_terminal() || root.status.is_terminal() {
                        for (d, _) in &items {
                            db.set_delivery(&d.message_id, &d.recipient, DeliveryState::Cancelled)?;
                        }
                        continue;
                    }
                    if root.paused
                        || root.status == TaskStatus::Blocked
                        || db.running_attempt(&task.id, &persona)?.is_some()
                    {
                        continue;
                    }
                    if self.roster().get(&persona).is_none() {
                        for (d, _) in &items {
                            db.set_delivery(&d.message_id, &d.recipient, DeliveryState::Failed)?;
                        }
                        continue;
                    }
                    if let Charged::Exhausted(reason) =
                        db.charge(&task.root_id, Charge::Dispatch)?
                    {
                        exhausted.push((task.root_id.clone(), reason));
                        continue;
                    }
                    let attempt = self.new_attempt(db, &task, AttemptKind::Inbox, &persona)?;
                    for (d, _) in &items {
                        db.set_delivery(&d.message_id, &d.recipient, DeliveryState::Processing)?;
                    }
                    out.push(Dispatch {
                        attempt,
                        task,
                        deliveries: items,
                    });
                }
            }
            for (root, reason) in exhausted {
                self.block_root(db, &root, &format!("budget exhausted: {reason}"))?;
            }
            Ok(out)
        })?;
        self.changed();
        Ok(claimed)
    }

    fn new_attempt(
        &self,
        db: &Db<'_>,
        task: &Task,
        kind: AttemptKind,
        persona: &str,
    ) -> CoordResult<Attempt> {
        let now = db.now;
        let attempt = Attempt {
            id: new_id("at"),
            task_id: task.id.clone(),
            kind,
            persona: persona.to_owned(),
            instance_id: AgentInstanceId::new(task_room(&task.id), persona).encode(),
            runtime_epoch: None,
            dispatch_id: new_id("dp"),
            fencing: db.next_fencing(&task.id)?,
            lease_expires_at: now + self.config.lease_secs as i64,
            heartbeat_at: now,
            state: AttemptState::Running,
            failure_class: None,
            failure_detail: None,
            worktree: None,
            branch: None,
            started_at: now,
            ended_at: None,
            context_metrics: None,
        };
        db.insert_attempt(&attempt)?;
        db.event(&task.root_id, Some(&task.id), persona, "attempt.started", serde_json::json!({"attempt_id": attempt.id, "kind": kind.as_str(), "persona": persona, "fencing": attempt.fencing}))?;
        db.event(&task.root_id, Some(&task.id), persona, "agent.activity.changed", serde_json::json!({"persona": persona, "state": activity_for(kind), "task_id": task.id}))?;
        Ok(attempt)
    }

    pub fn heartbeat(&self, attempt_id: &str) -> CoordResult<bool> {
        let lease = self.config.lease_secs as i64;
        self.store.write(|db| db.heartbeat(attempt_id, lease))
    }

    pub fn record_attempt_workspace(
        &self,
        attempt_id: &str,
        worktree: Option<&str>,
        branch: Option<&str>,
    ) -> CoordResult<()> {
        self.store
            .write(|db| db.set_attempt_workspace(attempt_id, worktree, branch))
    }

    pub fn record_attempt_metrics(
        &self,
        attempt_id: &str,
        metrics: &serde_json::Value,
    ) -> CoordResult<()> {
        self.store
            .write(|db| db.set_attempt_metrics(attempt_id, metrics))
    }

    pub fn record_attempt_epoch(&self, attempt_id: &str, epoch: &str) -> CoordResult<()> {
        self.store
            .write(|db| db.set_attempt_epoch(attempt_id, epoch))
    }

    pub fn record_artifact(
        &self,
        task: &str,
        attempt: Option<&str>,
        kind: &str,
        reference: &str,
        hash: Option<&str>,
        description: &str,
    ) -> CoordResult<Artifact> {
        self.store
            .write(|db| db.add_artifact(task, attempt, kind, reference, hash, description))
    }

    /// Record how an attempt ended and move its task accordingly. Never
    /// reports success for an attempt that produced no accepted result.
    pub fn finish_attempt(&self, attempt_id: &str, end: AttemptEnd) -> CoordResult<()> {
        self.forget_attempt(attempt_id);
        self.store.write(|db| {
            let Some(attempt) = db.attempt(attempt_id)? else { return Ok(()) };
            let (state, class, detail) = match &end {
                AttemptEnd::Completed => (AttemptState::Succeeded, None, None),
                AttemptEnd::Failed { class, detail } => (AttemptState::Failed, Some(class.as_str()), Some(clip(detail, 500))),
                AttemptEnd::Cancelled => (AttemptState::Cancelled, None, None),
                AttemptEnd::Interrupted => (AttemptState::Interrupted, Some("interrupted"), Some("attempt lease expired or the process stopped before it finished")),
            };
            if !db.finish_attempt(attempt_id, state, class, detail)? {
                return Ok(());
            }
            let task = db.task_or_err(&attempt.task_id)?;
            db.event(&task.root_id, Some(&attempt.task_id), &attempt.persona, "attempt.finished", serde_json::json!({"attempt_id": attempt_id, "state": state.as_str(), "class": class}))?;
            db.event(&task.root_id, Some(&task.id), &attempt.persona, "agent.activity.changed", serde_json::json!({"persona": attempt.persona, "state": "idle", "task_id": task.id}))?;
            let block = |reason: &str| -> CoordResult<()> {
                if task.status.can_transition_to(TaskStatus::Blocked) {
                    db.set_status(&task.id, TaskStatus::Blocked, Some(reason), "hivemind", None)?;
                }
                Ok(())
            };
            match (attempt.kind, &end) {
                (_, AttemptEnd::Cancelled) => {}
                (AttemptKind::Work, AttemptEnd::Completed) if task.status == TaskStatus::Running => block("attempt ended without submitting a result or reporting a blocker")?,
                (AttemptKind::Work, AttemptEnd::Failed { class, .. }) if task.status == TaskStatus::Running || (task.status == TaskStatus::Review && matches!(class.as_str(), "unresolved_conflict" | "workspace")) => {
                    // A submitted result whose deliverable could not be committed must not reach review.
                    db.set_status(&task.id, TaskStatus::Failed, Some(&format!("attempt failed: {class}")), "hivemind", None)?;
                }
                (AttemptKind::Work, AttemptEnd::Interrupted) if task.status == TaskStatus::Running => block("attempt interrupted; explicit retry required (side effects may have occurred)")?,
                (AttemptKind::Plan, AttemptEnd::Completed) if task.status == TaskStatus::Planning => {
                    db.set_status(&task.id, TaskStatus::NeedsInput, Some("coordinator finished without proposing a plan"), "hivemind", None)?;
                }
                (AttemptKind::Plan, AttemptEnd::Failed { class, .. }) if task.status == TaskStatus::Planning => {
                    db.set_status(&task.id, TaskStatus::Failed, Some(&format!("planning failed: {class}")), "hivemind", None)?;
                }
                (AttemptKind::Plan, AttemptEnd::Interrupted) if task.status == TaskStatus::Planning => block("planning interrupted; explicit retry required")?,
                (AttemptKind::Review, AttemptEnd::Completed) if task.status == TaskStatus::Review => block("reviewer ended without a verdict")?,
                (AttemptKind::Review, AttemptEnd::Failed { class, .. }) if task.status == TaskStatus::Review => block(&format!("review attempt failed: {class}"))?,
                (AttemptKind::Review, AttemptEnd::Interrupted) if task.status == TaskStatus::Review => block("review interrupted; explicit retry required")?,
                _ => {}
            }
            if attempt.kind == AttemptKind::Inbox {
                let acked = matches!(end, AttemptEnd::Completed);
                for (delivery, _) in db.inbox(&attempt.persona, &task.root_id, &[DeliveryState::Processing], 100)? {
                    let next = if acked { DeliveryState::Acknowledged } else if matches!(end, AttemptEnd::Interrupted) { DeliveryState::Queued } else { DeliveryState::Failed };
                    if next == DeliveryState::Queued {
                        // Interrupted mid-processing: keep it visible but never auto-replay.
                        db.set_delivery(&delivery.message_id, &delivery.recipient, DeliveryState::Failed)?;
                    } else {
                        db.set_delivery(&delivery.message_id, &delivery.recipient, next)?;
                    }
                }
            }
            self.refresh_graph(db)?;
            Ok(())
        })?;
        self.changed();
        Ok(())
    }

    /// Interrupt running attempts whose lease expired and that this process
    /// is not executing (`live`). With `all`, every running attempt not in
    /// `live` is interrupted: used at startup, when nothing can be running.
    pub fn interrupt_orphans(&self, live: &HashSet<String>, all: bool) -> CoordResult<usize> {
        let orphans: Vec<Attempt> = self.store.read(|db| {
            if all {
                db.running_attempts(None)
            } else {
                db.expired_attempts()
            }
        })?;
        let mut count = 0;
        for attempt in orphans.into_iter().filter(|a| !live.contains(&a.id)) {
            self.finish_attempt(&attempt.id, AttemptEnd::Interrupted)?;
            count += 1;
        }
        Ok(count)
    }

    /// Host-side move to `preferred`, falling back to `blocked` when the
    /// lifecycle does not allow it (for example an oversized mandatory goal).
    pub fn host_transition(
        &self,
        task_id: &str,
        preferred: TaskStatus,
        reason: &str,
    ) -> CoordResult<()> {
        self.store.write(|db| {
            let task = db.task_or_err(task_id)?;
            let next = if task.status.can_transition_to(preferred) {
                preferred
            } else {
                TaskStatus::Blocked
            };
            if task.status.can_transition_to(next) {
                db.set_status(task_id, next, Some(clip(reason, 800)), "hivemind", None)?;
            }
            Ok(())
        })?;
        self.changed();
        Ok(())
    }

    /// Attempts still running whose task is terminal: the scheduler aborts them.
    pub fn attempts_to_abort(&self) -> CoordResult<Vec<String>> {
        self.store.read(|db| {
            let mut out = Vec::new();
            for attempt in db.running_attempts(None)? {
                let task = db.task_or_err(&attempt.task_id)?;
                if task.status.is_terminal() {
                    out.push(attempt.id);
                }
            }
            Ok(out)
        })
    }

    // ------------------------------------------------------------------
    // Tool-bound context
    // ------------------------------------------------------------------

    /// Bind a room and persona to their live attempt, if any.
    pub fn bind(&self, room: &str, persona: &str) -> CoordResult<Option<ToolCtx>> {
        if !self.config.enabled {
            return Ok(None);
        }
        let Some(task_id) = task_of_room(room) else {
            return Ok(None);
        };
        self.store.read(|db| {
            let Some(task) = db.task(task_id)? else {
                return Ok(None);
            };
            Ok(db
                .running_attempt(task_id, persona)?
                .map(|attempt| ToolCtx {
                    persona: persona.to_owned(),
                    room: room.to_owned(),
                    task_id: task.id,
                    root_id: task.root_id,
                    attempt_id: attempt.id,
                    fencing: attempt.fencing,
                    kind: attempt.kind,
                }))
        })
    }

    /// Charge one tool action and verify the attempt still holds its lease.
    pub fn live(&self, ctx: &ToolCtx) -> CoordResult<Task> {
        self.charge(&ctx.root_id, Charge::ToolAction)?;
        let lease = self.config.lease_secs as i64;
        self.store.write(|db| {
            let attempt = db
                .attempt(&ctx.attempt_id)?
                .ok_or_else(|| CoordError::Conflict("attempt no longer exists".into()))?;
            if attempt.state != AttemptState::Running
                || attempt.fencing != ctx.fencing
                || attempt.persona != ctx.persona
            {
                return conflict("stale attempt: this dispatch was superseded or has ended");
            }
            if attempt.lease_expires_at < db.now {
                return conflict("attempt lease expired; result rejected");
            }
            db.heartbeat(&ctx.attempt_id, lease)?;
            let task = db.task_or_err(&ctx.task_id)?;
            if task.status.is_terminal() {
                return conflict(format!("task is {}", task.status.as_str()));
            }
            Ok(task)
        })
    }

    // ------------------------------------------------------------------
    // Task tools
    // ------------------------------------------------------------------

    pub fn propose_plan(
        &self,
        ctx: &ToolCtx,
        plan: &Plan,
        expected_revision: Option<i64>,
    ) -> CoordResult<Vec<(String, String)>> {
        let task = self.live(ctx)?;
        let ids = self.store.write(|db| {
            let root = db.task_or_err(&task.root_id)?;
            if ctx.kind != AttemptKind::Plan || ctx.persona != root.coordinator || root.status != TaskStatus::Planning || task.id != root.id {
                return forbid("plans are accepted only from the coordinator's planning attempt on a root task in planning");
            }
            if let Some(expected) = expected_revision {
                if expected != root.revision {
                    return conflict(format!("task '{}' is at revision {}, not {expected}", root.id, root.revision));
                }
            }
            let resolved = self.resolve_plan(db, plan, &root, &root, &root.coordinator)?;
            self.commit_plan(db, &root, &root, resolved, &ctx.persona)
        })?;
        self.changed();
        Ok(ids)
    }

    pub fn delegate(&self, ctx: &ToolCtx, req: Delegate) -> CoordResult<String> {
        let task = self.live(ctx)?;
        let id = self.store.write(|db| {
            let root = db.task_or_err(&task.root_id)?;
            let roster = self.roster();
            let persona = roster
                .get(&ctx.persona)
                .ok_or_else(|| CoordError::Forbidden("unknown persona".into()))?;
            if !(persona.has_permission("delegate") || root.coordinator == ctx.persona) {
                return forbid(format!(
                    "persona '{}' lacks the 'delegate' permission",
                    ctx.persona
                ));
            }
            if root.status.is_terminal() || root.status == TaskStatus::Blocked {
                return conflict(format!("root task is {}", root.status.as_str()));
            }
            if !matches!(ctx.kind, AttemptKind::Work | AttemptKind::Plan) {
                return forbid("only work and planning attempts may delegate");
            }
            let plan = Plan {
                tasks: vec![super::policy::PlanTask {
                    key: "delegated".into(),
                    objective: req.objective.clone(),
                    acceptance: req.acceptance.clone(),
                    capabilities: req.capabilities.clone(),
                    owner: req.owner.clone(),
                    reviewer: req.reviewer.clone(),
                    depends_on: req.depends_on.clone(),
                    contract: None,
                    kind: None,
                }],
            };
            let resolved = self.resolve_plan(db, &plan, &root, &task, &root.coordinator)?;
            // Suppress an equivalent delegation already recorded by this caller.
            for sibling in db.children(&task.id)? {
                if sibling.objective == resolved[0].objective
                    && sibling.owner.as_deref() == Some(resolved[0].owner.as_str())
                    && !sibling.status.is_terminal()
                {
                    return Ok(sibling.id);
                }
            }
            let ids = self.commit_plan(db, &root, &task, resolved, &ctx.persona)?;
            Ok(ids[0].1.clone())
        })?;
        self.changed();
        Ok(id)
    }

    pub fn reassign(
        &self,
        ctx: &ToolCtx,
        target: &str,
        owner: &str,
        expected_revision: Option<i64>,
    ) -> CoordResult<()> {
        let caller_task = self.live(ctx)?;
        self.store.write(|db| {
            let task = db.task_or_err(target)?;
            if task.root_id != caller_task.root_id {
                return forbid("task belongs to a different root task");
            }
            let root = db.task_or_err(&task.root_id)?;
            let roster = self.roster();
            let persona = roster.get(&ctx.persona).ok_or_else(|| CoordError::Forbidden("unknown persona".into()))?;
            if !(persona.has_permission("task.reassign") || root.coordinator == ctx.persona) {
                return forbid(format!("persona '{}' lacks the 'task.reassign' permission", ctx.persona));
            }
            if let Some(expected) = expected_revision {
                if expected != task.revision {
                    return conflict(format!("task '{target}' is at revision {}, not {expected}", task.revision));
                }
            }
            if !matches!(task.status, TaskStatus::Submitted | TaskStatus::Ready | TaskStatus::Blocked | TaskStatus::NeedsInput) || !db.running_attempts(Some(target))?.is_empty() {
                return conflict("only pending work with no running attempt can be reassigned; cancel or wait for running attempts");
            }
            let roster = self.roster();
            let new_owner = roster.get(owner).ok_or_else(|| CoordError::Invalid(format!("'{owner}' is not a configured persona")))?;
            if !Roster::eligible_for_workspace(new_owner, &task.workspace) {
                return forbid(format!("persona '{owner}' is not eligible for workspace '{}'", task.workspace));
            }
            if new_owner.covers(&task.capabilities) != task.capabilities.len() {
                return forbid(format!("persona '{owner}' lacks capabilities required by the task"));
            }
            if task.kind == TaskKind::Integrate && !new_owner.has_permission("integrate") {
                return forbid(format!("persona '{owner}' lacks the 'integrate' permission"));
            }
            if !new_owner.may_write() {
                return forbid(format!("persona '{owner}' cannot change files (no 'workspace.write') and cannot own this task"));
            }
            let reviewer = task.reviewer.clone().filter(|r| !r.is_empty()).unwrap_or_else(|| root.coordinator.clone());
            if task.id != task.root_id && self.roster().personas().len() > 1 && reviewer == owner {
                return forbid(format!("persona '{owner}' is the reviewer of this task and cannot also own it"));
            }
            db.set_owner(target, owner, None)?;
            db.event(&task.root_id, Some(target), &ctx.persona, "task.reassigned", serde_json::json!({"from": task.owner, "to": owner}))?;
            Ok(())
        })?;
        self.changed();
        Ok(())
    }

    pub fn progress(&self, ctx: &ToolCtx, note: &str) -> CoordResult<()> {
        let task = self.live(ctx)?;
        let note = check_text("progress note", note, 500)?;
        self.store.write(|db| {
            db.event(
                &task.root_id,
                Some(&task.id),
                &ctx.persona,
                "task.progress",
                serde_json::json!({"note": note}),
            )?;
            Ok(())
        })?;
        self.changed();
        Ok(())
    }

    pub fn block(&self, ctx: &ToolCtx, reason: &str, needs_input: bool) -> CoordResult<()> {
        let task = self.live(ctx)?;
        let reason = check_text("reason", reason, 800)?;
        if !matches!(ctx.kind, AttemptKind::Work | AttemptKind::Plan) {
            return forbid("only work and planning attempts may block a task");
        }
        self.store.write(|db| {
            let next = if needs_input {
                TaskStatus::NeedsInput
            } else {
                TaskStatus::Blocked
            };
            if !matches!(task.status, TaskStatus::Running | TaskStatus::Planning) {
                return conflict(format!("task is {}, not running", task.status.as_str()));
            }
            db.set_status(&task.id, next, Some(&reason), &ctx.persona, None)?;
            Ok(())
        })?;
        self.changed();
        Ok(())
    }

    pub fn submit_result(&self, ctx: &ToolCtx, result: ResultIn) -> CoordResult<()> {
        let task = self.live(ctx)?;
        if ctx.kind != AttemptKind::Work {
            return forbid("only a work attempt may submit a result");
        }
        if task.owner.as_deref() != Some(ctx.persona.as_str()) {
            return forbid("only the task owner may submit its result");
        }
        if task.status != TaskStatus::Running {
            return conflict(format!("task is {}, not running", task.status.as_str()));
        }
        let summary = check_text("summary", &result.summary, 4000)?;
        if result.verification.is_empty() {
            return invalid("verification evidence is required: list each check with outcome passed, failed, or unavailable");
        }
        if result.verification.len() > 20 || result.artifacts.len() > 16 {
            return invalid("at most 20 verification entries and 16 artifacts");
        }
        let mut evidence = Vec::new();
        for entry in &result.verification {
            evidence.push(Evidence {
                check: check_text("verification check", &entry.check, 300)?,
                outcome: entry.outcome,
                detail: clip(entry.detail.trim(), 1000).to_owned(),
            });
        }
        let mut artifacts = Vec::new();
        for artifact in &result.artifacts {
            let kind = check_text("artifact kind", &artifact.kind, 32)?;
            if kind == "commit" || kind == "summary" {
                return forbid(
                    "commit and summary artifacts are recorded by Hivemind, not by agents",
                );
            }
            artifacts.push((
                kind,
                check_text("artifact reference", &artifact.reference, 512)?,
                clip(artifact.description.trim(), 500).to_owned(),
            ));
        }
        self.store.write(|db| {
            db.add_artifact(
                &task.id,
                Some(&ctx.attempt_id),
                "summary",
                &format!("summary:{}", ctx.attempt_id),
                None,
                &summary,
            )?;
            for (kind, reference, description) in &artifacts {
                db.add_artifact(
                    &task.id,
                    Some(&ctx.attempt_id),
                    kind,
                    reference,
                    None,
                    description,
                )?;
            }
            for entry in &evidence {
                db.add_evidence(&task.id, Some(&ctx.attempt_id), entry)?;
            }
            db.event(
                &task.root_id,
                Some(&task.id),
                &ctx.persona,
                "task.result_submitted",
                serde_json::json!({"artifacts": artifacts.len(), "verification": evidence.len()}),
            )?;
            db.set_status(&task.id, TaskStatus::Review, None, &ctx.persona, None)?;
            Ok(())
        })?;
        self.changed();
        Ok(())
    }

    pub fn review(&self, ctx: &ToolCtx, approve: bool, notes: &str) -> CoordResult<TaskStatus> {
        let task = self.live(ctx)?;
        if ctx.kind != AttemptKind::Review {
            return forbid("verdicts are accepted only from a review attempt");
        }
        let expected = task
            .reviewer
            .clone()
            .filter(|r| !r.is_empty())
            .unwrap_or_else(|| task.coordinator.clone());
        if ctx.persona != expected {
            return forbid(format!("only '{expected}' may review this task"));
        }
        if task.id != task.root_id
            && self.roster().personas().len() > 1
            && task.owner.as_deref() == Some(ctx.persona.as_str())
        {
            return forbid("an owner cannot review its own task");
        }
        if task.status != TaskStatus::Review {
            return conflict(format!(
                "task is {}, not awaiting review",
                task.status.as_str()
            ));
        }
        if approve && task.id != task.root_id {
            if let Some(execution) = self.execution.get().filter(|e| !e.config.checks.is_empty()) {
                let artifacts = self.store.read(|db| db.artifacts(&task.id))?;
                let sha = artifacts
                    .iter()
                    .rev()
                    .find(|a| a.kind == "commit")
                    .and_then(|a| a.content_hash.as_deref())
                    .ok_or_else(|| {
                        CoordError::Conflict(
                            "host verification needs a committed deliverable".into(),
                        )
                    })?;
                if !execution
                    .verified(&task.id, sha)
                    .map_err(|e| CoordError::Internal(e.to_string()))?
                {
                    return conflict(
                        "configured host verification has not passed for the submitted commit",
                    );
                }
            }
        }
        let notes = notes.trim();
        let status = self.store.write(|db| {
            let is_root = task.id == task.root_id;
            if approve {
                if is_root {
                    let tasks = db.list_tasks(&TaskFilter {
                        root: Some(&task.root_id),
                        limit: 500,
                        ..Default::default()
                    })?;
                    if let Some(open) = tasks
                        .iter()
                        .find(|t| t.id != task.id && t.status != TaskStatus::Completed)
                    {
                        return conflict(format!(
                            "cannot approve: task {} is {}",
                            open.id,
                            open.status.as_str()
                        ));
                    }
                } else {
                    let evidence = db.latest_evidence(&task.id)?;
                    if evidence.is_empty() {
                        return conflict("cannot approve: no verification evidence was submitted");
                    }
                    if let Some(failed) = evidence.iter().find(|e| e.outcome == Verdict::Failed) {
                        return conflict(format!(
                            "cannot approve: verification '{}' failed",
                            failed.check
                        ));
                    }
                    if !db.artifacts(&task.id)?.iter().any(|a| {
                        !matches!(
                            a.kind.as_str(),
                            "summary" | "recovery" | "recovery_selected" | "recovery_discarded"
                        )
                    }) {
                        return conflict("cannot approve: no deliverable artifact is recorded");
                    }
                }
                if !notes.is_empty() {
                    db.push_feedback(&task.id, &format!("approved: {}", clip(notes, 400)))?;
                }
                db.set_status(&task.id, TaskStatus::Completed, None, &ctx.persona, None)?;
                if is_root {
                    self.finish_root(db, &task.root_id)?;
                }
                Ok(TaskStatus::Completed)
            } else {
                if notes.is_empty() {
                    return invalid("a rejection needs notes explaining what must change");
                }
                db.push_feedback(
                    &task.id,
                    &format!("rejected by {}: {}", ctx.persona, clip(notes, 800)),
                )?;
                let used = db.attempt_count(&task.id)?;
                if used >= self.config.max_attempts_per_task {
                    db.set_status(
                        &task.id,
                        TaskStatus::Failed,
                        Some("rejected and attempt limit reached"),
                        &ctx.persona,
                        None,
                    )?;
                    return Ok(TaskStatus::Failed);
                }
                let next = if is_root {
                    TaskStatus::Planning
                } else {
                    TaskStatus::Ready
                };
                db.set_status(
                    &task.id,
                    next,
                    Some("rejected in review; repair required"),
                    &ctx.persona,
                    None,
                )?;
                Ok(next)
            }
        })?;
        self.changed();
        if status == TaskStatus::Failed {
            self.retire_task(&task.id);
        }
        Ok(status)
    }

    /// Root reached a terminal state: archive groups, cancel pending wakeups.
    fn finish_root(&self, db: &Db<'_>, root: &str) -> CoordResult<()> {
        db.archive_groups(root)?;
        db.cancel_deliveries(root)?;
        for id in db.task_ids(root)? {
            self.retire_task(&id);
        }
        Ok(())
    }

    fn retire_task(&self, task_id: &str) {
        let room = task_room(task_id);
        let personas: Vec<String> = self
            .roster()
            .personas()
            .iter()
            .map(|p| p.name.clone())
            .collect();
        let mut rotations = self.rotations.lock();
        for persona in personas {
            rotations.push((AgentInstanceId::new(room.clone(), persona), "task_finished"));
        }
    }

    pub fn decide(&self, ctx: &ToolCtx, decision_id: &str, accept: bool) -> CoordResult<()> {
        let task = self.live(ctx)?;
        let decided = self.store.write(|db| {
            let decision = db.decision(decision_id)?.ok_or_else(|| {
                CoordError::NotFound(format!("decision '{decision_id}' was not found"))
            })?;
            let target = db.task_or_err(&decision.task_id)?;
            if target.root_id != task.root_id {
                return forbid("decision belongs to a different root task");
            }
            let root = db.task_or_err(&task.root_id)?;
            let roster = self.roster();
            let persona = roster.get(&ctx.persona);
            if root.coordinator != ctx.persona
                && !persona.is_some_and(|p| {
                    p.has_permission("task.decide")
                        && target.reviewer.as_deref() == Some(ctx.persona.as_str())
                })
            {
                return forbid("only the coordinator or the task's reviewer may decide");
            }
            if decision.state != "proposed" {
                return conflict(format!("decision is already {}", decision.state));
            }
            db.set_decision(
                decision_id,
                if accept { "accepted" } else { "rejected" },
                &ctx.persona,
            )?;
            db.event(
                &task.root_id,
                Some(&target.id),
                &ctx.persona,
                "task.decision",
                serde_json::json!({"decision": decision_id, "accepted": accept}),
            )?;
            Ok(decision)
        })?;
        self.changed();
        if accept {
            self.steer_decision(&task.root_id, &ctx.persona, &decided);
        }
        Ok(())
    }

    // ------------------------------------------------------------------
    // Operator controls
    // ------------------------------------------------------------------

    /// Cancel a task and everything beneath it; a root also drops queued
    /// wakeups and archives its groups. Idempotent.
    pub fn cancel(&self, task_id: &str, actor: &str) -> CoordResult<TaskDetail> {
        self.store.write(|db| {
            let task = db.task_or_err(task_id)?;
            if task.status.is_terminal() {
                return Ok(());
            }
            let all = db.list_tasks(&TaskFilter {
                root: Some(&task.root_id),
                limit: 500,
                ..Default::default()
            })?;
            let mut doomed: HashSet<String> = HashSet::from([task.id.clone()]);
            loop {
                let before = doomed.len();
                for t in &all {
                    if t.parent_id.as_ref().is_some_and(|p| doomed.contains(p)) {
                        doomed.insert(t.id.clone());
                    }
                }
                if doomed.len() == before {
                    break;
                }
            }
            for t in all
                .iter()
                .filter(|t| doomed.contains(&t.id) && !t.status.is_terminal())
            {
                db.set_status(
                    &t.id,
                    TaskStatus::Cancelled,
                    Some("cancelled by request"),
                    actor,
                    None,
                )?;
                for attempt in db.running_attempts(Some(&t.id))? {
                    db.finish_attempt(
                        &attempt.id,
                        AttemptState::Cancelled,
                        Some("cancelled"),
                        None,
                    )?;
                }
            }
            if task.id == task.root_id {
                self.finish_root(db, &task.root_id)?;
            } else {
                for id in &doomed {
                    self.retire_task(id);
                }
            }
            self.refresh_graph(db)?;
            Ok(())
        })?;
        self.changed();
        self.detail(task_id)
    }

    pub fn pause(&self, root_id: &str, actor: &str) -> CoordResult<TaskDetail> {
        self.set_paused(root_id, true, actor)
    }

    fn set_paused(&self, root_id: &str, paused: bool, actor: &str) -> CoordResult<TaskDetail> {
        self.require_enabled()?;
        self.store.write(|db| {
            let task = db.task_or_err(root_id)?;
            if task.id != task.root_id {
                return invalid("pause and resume apply to root tasks");
            }
            if task.status.is_terminal() {
                return conflict(format!("task is {}", task.status.as_str()));
            }
            if task.paused != paused {
                db.set_paused(root_id, paused)?;
                db.event(
                    root_id,
                    Some(root_id),
                    actor,
                    if paused {
                        "task.paused"
                    } else {
                        "task.resumed"
                    },
                    serde_json::json!({}),
                )?;
            }
            Ok(())
        })?;
        self.changed();
        self.detail(root_id)
    }

    /// Resume dispatch. `retry` moves blocked tasks that hold no accepted
    /// result back to work: an explicit authorization to replay attempts that
    /// were interrupted, so side effects may repeat. `extra_dispatches` and
    /// `extra_secs` raise an exhausted budget.
    pub fn resume(
        &self,
        root_id: &str,
        retry: bool,
        extra_dispatches: u32,
        extra_secs: u64,
        actor: &str,
    ) -> CoordResult<TaskDetail> {
        self.require_enabled()?;
        self.store.write(|db| {
            let root = db.task_or_err(root_id)?;
            if root.id != root.root_id {
                return invalid("pause and resume apply to root tasks");
            }
            if root.status.is_terminal() {
                return conflict(format!("task is {}", root.status.as_str()));
            }
            if extra_dispatches > 0 || extra_secs > 0 {
                db.extend_usage(root_id, extra_dispatches, extra_secs)?;
            }
            if root.paused {
                db.set_paused(root_id, false)?;
                db.event(
                    root_id,
                    Some(root_id),
                    actor,
                    "task.resumed",
                    serde_json::json!({"retry": retry}),
                )?;
            }
            if retry || extra_dispatches > 0 || extra_secs > 0 {
                let tasks = db.list_tasks(&TaskFilter {
                    root: Some(root_id),
                    limit: 500,
                    ..Default::default()
                })?;
                for task in tasks.iter().filter(|t| {
                    matches!(t.status, TaskStatus::Blocked | TaskStatus::NeedsInput)
                        && t.id != root.id
                }) {
                    let dependency_stop = task
                        .status_reason
                        .as_deref()
                        .is_some_and(|r| r.starts_with("dependency "));
                    if !retry || dependency_stop {
                        continue;
                    }
                    let has_result = !db.latest_evidence(&task.id)?.is_empty()
                        && task
                            .status_reason
                            .as_deref()
                            .is_some_and(|r| r.starts_with("reviewer") || r.starts_with("review"));
                    db.set_status(
                        &task.id,
                        if has_result {
                            TaskStatus::Review
                        } else {
                            TaskStatus::Ready
                        },
                        Some("retry authorized"),
                        actor,
                        None,
                    )?;
                }
                if matches!(root.status, TaskStatus::Blocked | TaskStatus::NeedsInput) {
                    let has_children = tasks.iter().any(|t| t.id != root.id);
                    let reason = root.status_reason.as_deref().unwrap_or("");
                    let next = if !has_children
                        || reason.starts_with("planning")
                        || reason.starts_with("coordinator")
                    {
                        TaskStatus::Planning
                    } else {
                        TaskStatus::Running
                    };
                    if retry || reason.starts_with("budget exhausted") {
                        db.set_status(root_id, next, Some("resumed"), actor, None)?;
                    }
                }
            }
            self.refresh_graph(db)?;
            Ok(())
        })?;
        self.changed();
        self.detail(root_id)
    }

    /// Answer a `needs_input` task: adds the user's answer as feedback and resubmits it.
    pub fn provide_input(
        &self,
        task_id: &str,
        answer: &str,
        actor: &str,
    ) -> CoordResult<TaskDetail> {
        self.require_enabled()?;
        let answer = check_text("answer", answer, 4000)?;
        // A running attempt waiting on `tasks.ask` takes the answer live.
        if self.answer_question(task_id, &answer, actor) {
            return self.detail(task_id);
        }
        self.store.write(|db| {
            let task = db.task_or_err(task_id)?;
            if task.status != TaskStatus::NeedsInput {
                return conflict(format!(
                    "task is {}, not waiting for input",
                    task.status.as_str()
                ));
            }
            db.push_feedback(task_id, &format!("user input: {answer}"))?;
            let next = if task.id == task.root_id {
                TaskStatus::Planning
            } else {
                TaskStatus::Ready
            };
            db.set_status(task_id, next, Some("input provided"), actor, None)?;
            Ok(())
        })?;
        self.changed();
        self.detail(task_id)
    }

    // ------------------------------------------------------------------
    // Messaging
    // ------------------------------------------------------------------

    pub fn send_message(&self, ctx: &ToolCtx, req: SendMessage) -> CoordResult<(Message, bool)> {
        self.send_message_live(ctx, req)
            .map(|(message, duplicate, _)| (message, duplicate))
    }

    /// Send a message, then take the live fast paths: a reply to an open
    /// `tasks.ask` question answers it, and recipients that are mid-attempt
    /// get it steered into their session. Also returns who got it live.
    pub fn send_message_live(
        &self,
        ctx: &ToolCtx,
        req: SendMessage,
    ) -> CoordResult<(Message, bool, Vec<String>)> {
        let (message, duplicate) = self.store_message(ctx, req)?;
        if duplicate {
            return Ok((message, true, Vec::new()));
        }
        if self.answer_from_message(&message) {
            return Ok((message, false, Vec::new()));
        }
        let live = self.steer_message(&message);
        Ok((message, false, live))
    }

    fn store_message(&self, ctx: &ToolCtx, req: SendMessage) -> CoordResult<(Message, bool)> {
        let task = self.live(ctx)?;
        let body = check_text("message body", &req.body, 6000)?;
        if req.artifacts.len() > 8 {
            return invalid("at most 8 artifact references per message");
        }
        if req.kind == MessageKind::Ack && req.causation.is_none() {
            return invalid("an ack must reference the message it acknowledges (causation)");
        }
        let key = req
            .idempotency_key
            .as_deref()
            .map(|k| check_text("idempotency key", k, 128))
            .transpose()?;
        self.charge(&ctx.root_id, Charge::Message)?;
        let out = self.store.write(|db| {
            if let Some(key) = &key {
                if let Some(existing) = db.message_by_key(&ctx.persona, key)? {
                    return Ok((existing, true));
                }
            }
            let root = db.task_or_err(&task.root_id)?;
            if root.status.is_terminal() || root.paused {
                return conflict(format!("root task is {}", if root.paused { "paused" } else { root.status.as_str() }));
            }
            let mut recipients: Vec<String> = Vec::new();
            let mut group_id: Option<String> = None;
            if let Some(gid) = &req.group {
                let group = db.group(gid)?.ok_or_else(|| CoordError::NotFound(format!("group '{gid}' was not found")))?;
                if group.root_id != task.root_id || !group.active {
                    return forbid("group is not active for this root task");
                }
                if !db.is_member(gid, &ctx.persona)? {
                    return forbid("you are not a member of that group");
                }
                recipients = group.members.iter().map(|m| m.persona.clone()).filter(|p| *p != ctx.persona).collect();
                group_id = Some(gid.clone());
            }
            for name in &req.recipients {
                let name = name.trim().to_owned();
                if name == ctx.persona {
                    return invalid("cannot send a message to yourself");
                }
                let roster = self.roster();
                let persona = roster.get(&name).ok_or_else(|| CoordError::Invalid(format!("unknown recipient '{name}'")))?;
                if !Roster::eligible_for_workspace(persona, &root.workspace) {
                    return forbid(format!("'{name}' is not part of this task's workspace"));
                }
                if !recipients.contains(&name) {
                    recipients.push(name);
                }
            }
            if recipients.is_empty() {
                return invalid("no recipients: name at least one persona or a group");
            }
            recipients.sort();
            if recipients.len() > 8 {
                return invalid("at most 8 recipients per message");
            }
            for artifact in &req.artifacts {
                let found = db.artifact(artifact)?.ok_or_else(|| CoordError::NotFound(format!("artifact '{artifact}' was not found")))?;
                if db.task_or_err(&found.task_id)?.root_id != task.root_id {
                    return forbid(format!("artifact '{artifact}' is outside this root task"));
                }
            }
            let (depth, cause_kind, thread) = match req.causation.as_deref() {
                Some(cause) => {
                    let parent = db.message(cause)?.ok_or_else(|| CoordError::NotFound(format!("message '{cause}' was not found")))?;
                    if parent.root_id != task.root_id || !(parent.sender == ctx.persona || parent.recipients.contains(&ctx.persona)) {
                        return forbid("you are not a party to the referenced message");
                    }
                    (parent.depth + 1, Some(parent.kind), parent.thread.clone())
                }
                None => (0, None, String::new()),
            };
            if let Some(existing) = db.equivalent_message(&task.root_id, &task.id, &ctx.persona, req.kind, &recipients, group_id.as_deref(), &body)? {
                return Ok((existing, true));
            }
            let wake = req.kind.wakes_recipient() && depth <= self.config.max_message_depth && !matches!(cause_kind, Some(MessageKind::Ack | MessageKind::Status));
            let id = new_id("mg");
            let thread = if thread.is_empty() { id.clone() } else { thread };
            db.insert_message(&NewMessage {
                id: id.clone(),
                root_id: &task.root_id,
                task_id: &task.id,
                sender: &ctx.persona,
                sender_instance: &AgentInstanceId::new(&ctx.room, &ctx.persona).encode(),
                kind: req.kind,
                recipients: &recipients,
                group_id: group_id.as_deref(),
                body: &body,
                artifacts: &req.artifacts,
                causation_id: req.causation.as_deref(),
                depth,
                correlation_id: task.root_id.clone(),
                thread,
                idempotency_key: key.as_deref(),
                wake,
            })?;
            if req.kind == MessageKind::DecisionProposal {
                db.insert_decision(&task.id, &body, &ctx.persona, Some(&id))?;
            }
            db.event(&task.root_id, Some(&task.id), &ctx.persona, "message.sent", serde_json::json!({"message_id": id, "kind": req.kind.as_str(), "recipients": recipients, "group_id": group_id, "wake": wake}))?;
            let message = db.message(&id)?.ok_or_else(|| CoordError::Internal("message vanished".into()))?;
            Ok((message, false))
        })?;
        self.changed();
        Ok(out)
    }

    /// Bounded mailbox read. Non-waking queued items become `delivered`;
    /// queued wakeups stay queued for the scheduler.
    pub fn inbox(&self, ctx: &ToolCtx, limit: usize) -> CoordResult<Vec<(Delivery, Message)>> {
        self.live(ctx)?;
        let items = self.store.write(|db| {
            let items = db.inbox(
                &ctx.persona,
                &ctx.root_id,
                &[
                    DeliveryState::Queued,
                    DeliveryState::Delivered,
                    DeliveryState::Processing,
                ],
                limit.clamp(1, 8),
            )?;
            for (delivery, _) in &items {
                if delivery.state == DeliveryState::Queued && !delivery.wake {
                    db.set_delivery(
                        &delivery.message_id,
                        &delivery.recipient,
                        DeliveryState::Delivered,
                    )?;
                }
            }
            Ok(items)
        })?;
        Ok(items)
    }

    pub fn ack(&self, ctx: &ToolCtx, message_id: &str) -> CoordResult<()> {
        self.live(ctx)?;
        self.store.write(|db| {
            let Some(delivery) = db.delivery(message_id, &ctx.persona)? else {
                return Err(CoordError::NotFound(
                    "no such message addressed to you".into(),
                ));
            };
            let message = db
                .message(message_id)?
                .ok_or_else(|| CoordError::NotFound("message not found".into()))?;
            if message.root_id != ctx.root_id {
                return forbid("message belongs to a different root task");
            }
            if db.set_delivery(message_id, &delivery.recipient, DeliveryState::Acknowledged)? {
                db.event(
                    &ctx.root_id,
                    Some(&message.task_id),
                    &ctx.persona,
                    "message.delivery_changed",
                    serde_json::json!({"message_id": message_id, "state": "acknowledged"}),
                )?;
            }
            Ok(())
        })?;
        self.changed();
        Ok(())
    }

    // ------------------------------------------------------------------
    // Groups
    // ------------------------------------------------------------------

    fn may_manage_groups(&self, db: &Db<'_>, ctx: &ToolCtx) -> CoordResult<Task> {
        let root = db.task_or_err(&ctx.root_id)?;
        let roster = self.roster();
        let persona = roster
            .get(&ctx.persona)
            .ok_or_else(|| CoordError::Forbidden("unknown persona".into()))?;
        if !(persona.has_permission("group.manage") || root.coordinator == ctx.persona) {
            return forbid(format!("persona '{}' may not manage groups: it needs the 'group.manage' permission (implied by 'coordinate' and 'delegate')", ctx.persona));
        }
        Ok(root)
    }

    pub fn create_group(&self, ctx: &ToolCtx, req: CreateGroup) -> CoordResult<(Group, bool)> {
        self.live(ctx)?;
        let purpose = check_text("purpose", &req.purpose, 300)?;
        let out = self.store.write(|db| {
            let root = self.may_manage_groups(db, ctx)?;
            if root.status.is_terminal() {
                return conflict(format!("root task is {}", root.status.as_str()));
            }
            let mut members: Vec<(String, String)> = vec![(ctx.persona.clone(), "creator".into())];
            for name in &req.members {
                let roster = self.roster();
                let persona = roster.get(name.trim()).ok_or_else(|| CoordError::Invalid(format!("'{name}' is not a configured persona")))?;
                if !Roster::eligible_for_workspace(persona, &root.workspace) {
                    return forbid(format!("'{}' is not part of this task's workspace", persona.name));
                }
                if !members.iter().any(|(m, _)| *m == persona.name) {
                    members.push((persona.name.clone(), "member".into()));
                }
            }
            let load = db.active_load()?;
            for role in &req.roles {
                let tag = normalize_tag(role);
                let exclude: Vec<&str> = members.iter().map(|(m, _)| m.as_str()).collect();
                // A role already covered by an existing member needs no extra persona.
                if members.iter().any(|(m, _)| self.roster().get(m).is_some_and(|p| p.capabilities.contains(&tag))) {
                    continue;
                }
                let roster = self.roster();
                let picked = roster.select(std::slice::from_ref(&tag), None, &root.workspace, &load, &exclude).map_err(|why| CoordError::Invalid(format!("role '{tag}' cannot be filled: {why}")))?;
                let name = picked.name.clone();
                members.push((name, tag));
            }
            if members.len() < 2 {
                return invalid("a group needs at least one member besides its creator");
            }
            if members.len() > 8 {
                return invalid("at most 8 group members");
            }
            members.sort();
            let purpose_key = purpose.to_lowercase();
            let membership_key = members.iter().map(|(m, _)| m.as_str()).collect::<Vec<_>>().join(",");
            if let Some(existing) = db.find_reusable_group(&root.id, &purpose_key, &membership_key)? {
                return Ok((db.group(&existing)?.ok_or_else(|| CoordError::Internal("group vanished".into()))?, true));
            }
            let id = new_id("gr");
            db.insert_group(&id, &root.id, &ctx.task_id, &purpose, &purpose_key, &membership_key, &ctx.persona)?;
            for (persona, role) in &members {
                db.add_member(&id, persona, role, 1)?;
            }
            db.event(&root.id, Some(&ctx.task_id), &ctx.persona, "group.created", serde_json::json!({"group_id": id, "purpose": purpose, "members": members.iter().map(|(m, _)| m.clone()).collect::<Vec<_>>()}))?;
            Ok((db.group(&id)?.ok_or_else(|| CoordError::Internal("group vanished".into()))?, false))
        })?;
        self.changed();
        Ok(out)
    }

    pub fn get_group(&self, ctx: &ToolCtx, id: &str) -> CoordResult<Group> {
        self.live(ctx)?;
        self.store.read(|db| {
            let group = db
                .group(id)?
                .ok_or_else(|| CoordError::NotFound(format!("group '{id}' was not found")))?;
            if group.root_id != ctx.root_id
                || !(db.is_member(id, &ctx.persona)?
                    || db.task_or_err(&ctx.root_id)?.coordinator == ctx.persona)
            {
                return forbid("you are not a member of that group");
            }
            Ok(group)
        })
    }

    pub fn update_members(
        &self,
        ctx: &ToolCtx,
        id: &str,
        add: &[String],
        remove: &[String],
        expected_revision: Option<i64>,
    ) -> CoordResult<Group> {
        self.live(ctx)?;
        let (group, removed) = self.store.write(|db| {
            let root = self.may_manage_groups(db, ctx)?;
            let group = db.group(id)?.ok_or_else(|| CoordError::NotFound(format!("group '{id}' was not found")))?;
            if group.root_id != root.id || !group.active {
                return forbid("group is not active for this root task");
            }
            if let Some(expected) = expected_revision {
                if expected != group.revision {
                    return conflict(format!("group '{id}' is at revision {}, not {expected}", group.revision));
                }
            }
            let revision = group.revision + 1;
            let mut removed = Vec::new();
            let mut current: Vec<String> = group.members.iter().map(|m| m.persona.clone()).collect();
            for name in remove {
                if db.remove_member(id, name, revision)? {
                    current.retain(|m| m != name);
                    removed.push(name.clone());
                }
            }
            for name in add {
                let roster = self.roster();
                let persona = roster.get(name.trim()).ok_or_else(|| CoordError::Invalid(format!("'{name}' is not a configured persona")))?;
                if !Roster::eligible_for_workspace(persona, &root.workspace) {
                    return forbid(format!("'{}' is not part of this task's workspace", persona.name));
                }
                if !current.contains(&persona.name) {
                    db.add_member(id, &persona.name, "member", revision)?;
                    current.push(persona.name.clone());
                }
            }
            if current.len() < 2 || current.len() > 8 {
                return invalid("a group must keep between 2 and 8 members");
            }
            current.sort();
            db.set_group_revision(id, revision, &current.join(","))?;
            db.event(&root.id, Some(&group.task_id), &ctx.persona, "group.members_changed", serde_json::json!({"group_id": id, "revision": revision, "added": add, "removed": removed}))?;
            Ok((db.group(id)?.ok_or_else(|| CoordError::Internal("group vanished".into()))?, removed))
        })?;
        // Removed members keep no stale context: rotate their sessions at the next safe boundary.
        for name in removed {
            self.rotations.lock().push((
                AgentInstanceId::new(task_room(&group.task_id), name),
                "membership_changed",
            ));
        }
        self.changed();
        Ok(group)
    }

    // ------------------------------------------------------------------
    // Read projections
    // ------------------------------------------------------------------

    pub fn detail(&self, id: &str) -> CoordResult<TaskDetail> {
        let questions = self.open_questions(id);
        self.store.read(|db| {
            let task = db.task_or_err(id)?;
            let all = db.list_tasks(&TaskFilter {
                root: Some(&task.root_id),
                limit: 500,
                ..Default::default()
            })?;
            let mut progress: HashMap<String, u32> = HashMap::new();
            for t in &all {
                *progress.entry(t.status.as_str().to_owned()).or_default() += 1;
            }
            let children = all
                .iter()
                .filter(|t| {
                    t.parent_id.as_deref() == Some(id)
                        || (task.id == task.root_id && t.id != task.id)
                })
                .map(|t| TaskSummary {
                    id: t.id.clone(),
                    objective: clip(&t.objective, 200).to_owned(),
                    owner: t.owner.clone(),
                    reviewer: t.reviewer.clone(),
                    status: t.status,
                    status_reason: t.status_reason.clone(),
                    prerequisites: t.prerequisites.clone(),
                })
                .collect();
            Ok(TaskDetail {
                artifacts: db.artifacts(id)?,
                evidence: db.latest_evidence(id)?,
                groups: if task.id == task.root_id {
                    db.list_groups(&task.root_id)?
                } else {
                    Vec::new()
                },
                usage: if task.id == task.root_id {
                    db.usage(id)?
                } else {
                    None
                },
                progress: if task.id == task.root_id {
                    progress
                } else {
                    HashMap::new()
                },
                questions,
                children,
                task,
            })
        })
    }

    pub fn list_tasks(&self, filter: &TaskFilter<'_>) -> CoordResult<Vec<Task>> {
        self.store.read(|db| db.list_tasks(filter))
    }

    pub fn attempts(&self, task_id: &str) -> CoordResult<Vec<Attempt>> {
        self.store.read(|db| {
            db.task_or_err(task_id)?;
            db.attempts_for_task(task_id, 200)
        })
    }

    pub fn events_after(
        &self,
        after: i64,
        root: Option<&str>,
        limit: usize,
    ) -> CoordResult<(Vec<CoordinationEvent>, i64)> {
        self.store
            .read(|db| Ok((db.events_after(after, root, limit)?, db.max_event_seq()?)))
    }

    pub fn messages(
        &self,
        root: &str,
        task: Option<&str>,
        thread: Option<&str>,
        after: Option<&str>,
        limit: usize,
    ) -> CoordResult<Vec<(Message, Vec<Delivery>)>> {
        self.store.read(|db| {
            db.task_or_err(root)?;
            db.list_messages(root, task, thread, after, limit)?
                .into_iter()
                .map(|m| Ok((db.deliveries_of(&m.id)?, m)))
                .map(|pair: CoordResult<(Vec<Delivery>, Message)>| pair.map(|(d, m)| (m, d)))
                .collect()
        })
    }

    /// Highest durable event sequence; snapshots pair with it so replay has no gap.
    pub fn high_water(&self) -> CoordResult<i64> {
        self.store.read(|db| db.max_event_seq())
    }

    /// A request or status message from the operator (the user) to personas on a task.
    pub fn operator_message(
        &self,
        task_id: &str,
        recipients: &[String],
        kind: MessageKind,
        body: &str,
    ) -> CoordResult<Message> {
        self.require_enabled()?;
        if !matches!(kind, MessageKind::Request | MessageKind::Status) {
            return invalid("operators may send request or status messages");
        }
        let body = check_text("message body", body, 6000)?;
        let task = self.store.read(|db| db.task_or_err(task_id))?;
        self.charge(&task.root_id, Charge::Message)?;
        let message = self.store.write(|db| {
            let root = db.task_or_err(&task.root_id)?;
            if root.status.is_terminal() || db.task_or_err(task_id)?.status.is_terminal() {
                return conflict("task is finished");
            }
            let mut to: Vec<String> = Vec::new();
            for name in recipients {
                let roster = self.roster();
                let persona = roster.get(name.trim()).ok_or_else(|| CoordError::Invalid(format!("unknown recipient '{name}'")))?;
                if !Roster::eligible_for_workspace(persona, &root.workspace) {
                    return forbid(format!("'{name}' is not part of this task's workspace"));
                }
                if !to.contains(&persona.name) {
                    to.push(persona.name.clone());
                }
            }
            if to.is_empty() || to.len() > 8 {
                return invalid("name between 1 and 8 recipients");
            }
            to.sort();
            let id = new_id("mg");
            db.insert_message(&NewMessage {
                id: id.clone(),
                root_id: &root.id,
                task_id,
                sender: "user",
                sender_instance: "user",
                kind,
                recipients: &to,
                group_id: None,
                body: &body,
                artifacts: &[],
                causation_id: None,
                depth: 0,
                correlation_id: root.id.clone(),
                thread: id.clone(),
                idempotency_key: None,
                wake: kind.wakes_recipient(),
            })?;
            db.event(&root.id, Some(task_id), "user", "message.sent", serde_json::json!({"message_id": id, "kind": kind.as_str(), "recipients": to, "wake": kind.wakes_recipient()}))?;
            db.message(&id)?.ok_or_else(|| CoordError::Internal("message vanished".into()))
        })?;
        self.changed();
        Ok(message)
    }

    /// An operator-created group on a task; reuses an active group with the same purpose and members.
    pub fn operator_group(
        &self,
        task_id: &str,
        purpose: &str,
        members: &[String],
    ) -> CoordResult<(Group, bool)> {
        self.require_enabled()?;
        let purpose = check_text("purpose", purpose, 300)?;
        let out = self.store.write(|db| {
            let task = db.task_or_err(task_id)?;
            let root = db.task_or_err(&task.root_id)?;
            if root.status.is_terminal() {
                return conflict(format!("root task is {}", root.status.as_str()));
            }
            let mut names: Vec<String> = Vec::new();
            for name in members {
                let roster = self.roster();
                let persona = roster.get(name.trim()).ok_or_else(|| {
                    CoordError::Invalid(format!("'{name}' is not a configured persona"))
                })?;
                if !Roster::eligible_for_workspace(persona, &root.workspace) {
                    return forbid(format!(
                        "'{}' is not part of this task's workspace",
                        persona.name
                    ));
                }
                if !names.contains(&persona.name) {
                    names.push(persona.name.clone());
                }
            }
            if names.len() < 2 || names.len() > 8 {
                return invalid("a group needs between 2 and 8 members");
            }
            names.sort();
            let purpose_key = purpose.to_lowercase();
            let membership_key = names.join(",");
            if let Some(existing) =
                db.find_reusable_group(&root.id, &purpose_key, &membership_key)?
            {
                return Ok((
                    db.group(&existing)?
                        .ok_or_else(|| CoordError::Internal("group vanished".into()))?,
                    true,
                ));
            }
            let id = new_id("gr");
            db.insert_group(
                &id,
                &root.id,
                task_id,
                &purpose,
                &purpose_key,
                &membership_key,
                "user",
            )?;
            for name in &names {
                db.add_member(&id, name, "member", 1)?;
            }
            db.event(
                &root.id,
                Some(task_id),
                "user",
                "group.created",
                serde_json::json!({"group_id": id, "purpose": purpose, "members": names}),
            )?;
            Ok((
                db.group(&id)?
                    .ok_or_else(|| CoordError::Internal("group vanished".into()))?,
                false,
            ))
        })?;
        self.changed();
        Ok(out)
    }

    pub fn group(&self, id: &str) -> CoordResult<Group> {
        self.store.read(|db| {
            db.group(id)?
                .ok_or_else(|| CoordError::NotFound(format!("group '{id}' was not found")))
        })
    }

    /// Persona availability derived from durable attempts and queues; a
    /// configured persona is not necessarily running.
    pub fn activity(&self) -> CoordResult<Vec<AgentActivity>> {
        let scheduler = self.scheduler_running.load(Ordering::SeqCst);
        self.store.read(|db| {
            let running = db.running_attempts(None)?;
            let mut out = Vec::new();
            for persona in self.roster().personas() {
                let mine: Vec<ActivityRef> = running
                    .iter()
                    .filter(|a| a.persona == persona.name)
                    .map(|a| ActivityRef {
                        instance_id: a.instance_id.clone(),
                        room_id: task_room(&a.task_id),
                        task_id: a.task_id.clone(),
                        attempt_id: a.id.clone(),
                        kind: a.kind,
                    })
                    .collect();
                let queued_wakes = if self.config.enabled {
                    db.queued_wakes_for(&persona.name)?
                } else {
                    0
                };
                let owned = if self.config.enabled {
                    db.list_tasks(&TaskFilter {
                        owner: Some(&persona.name),
                        limit: 200,
                        ..Default::default()
                    })?
                } else {
                    Vec::new()
                };
                let has = |status: TaskStatus| owned.iter().any(|t| t.status == status);
                let state = if let Some(first) = mine.first() {
                    match first.kind {
                        AttemptKind::Plan => "planning",
                        AttemptKind::Review => "reviewing",
                        _ => "working",
                    }
                } else if queued_wakes > 0 || has(TaskStatus::Ready) {
                    if scheduler {
                        "queued"
                    } else {
                        "offline"
                    }
                } else if has(TaskStatus::Blocked)
                    || has(TaskStatus::NeedsInput)
                    || has(TaskStatus::Review)
                {
                    "waiting"
                } else if db.latest_attempt_failed(&persona.name)? {
                    "failed"
                } else {
                    "idle"
                };
                out.push(AgentActivity {
                    persona: persona.name.clone(),
                    state: state.into(),
                    running: mine,
                    queued_wakes,
                });
            }
            Ok(out)
        })
    }
}

fn activity_for(kind: AttemptKind) -> &'static str {
    match kind {
        AttemptKind::Plan => "planning",
        AttemptKind::Review => "reviewing",
        _ => "working",
    }
}
