//! SQLite persistence for coordination. One writer connection in WAL mode;
//! every composite mutation runs in a single immediate transaction so state,
//! audit events, and delivery rows commit atomically.
use std::{
    collections::HashMap,
    path::Path,
    sync::atomic::{AtomicI64, Ordering},
    time::Duration,
};

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::de::DeserializeOwned;

use super::model::*;

impl From<rusqlite::Error> for CoordError {
    fn from(error: rusqlite::Error) -> Self {
        CoordError::Internal(format!("coordination store: {error}"))
    }
}

fn block<T>(f: impl FnOnce() -> T) -> T {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(f)
        }
        _ => f(),
    }
}

const SCHEMA_V1: &str = "
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, root_id TEXT NOT NULL, parent_id TEXT, depth INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'work', objective TEXT NOT NULL, acceptance TEXT NOT NULL, capabilities TEXT NOT NULL,
  workspace TEXT NOT NULL, coordinator TEXT NOT NULL, owner TEXT, reviewer TEXT,
  status TEXT NOT NULL, status_reason TEXT, revision INTEGER NOT NULL DEFAULT 1, paused INTEGER NOT NULL DEFAULT 0,
  feedback TEXT NOT NULL DEFAULT '[]', idempotency_key TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX tasks_root ON tasks(root_id, status);
CREATE INDEX tasks_owner ON tasks(owner, status);
CREATE INDEX tasks_status ON tasks(status);
CREATE UNIQUE INDEX tasks_idem ON tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id), prerequisite_id TEXT NOT NULL REFERENCES tasks(id),
  contract TEXT, PRIMARY KEY(task_id, prerequisite_id));
CREATE INDEX task_deps_prerequisite ON task_dependencies(prerequisite_id);
CREATE TABLE task_attempts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, persona TEXT NOT NULL,
  instance_id TEXT NOT NULL, runtime_epoch TEXT, dispatch_id TEXT NOT NULL, fencing INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, state TEXT NOT NULL,
  failure_class TEXT, failure_detail TEXT, worktree TEXT, branch TEXT, context_metrics TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER);
CREATE INDEX attempts_task ON task_attempts(task_id, started_at);
CREATE INDEX attempts_state ON task_attempts(state);
CREATE UNIQUE INDEX attempts_one_running ON task_attempts(task_id, persona) WHERE state='running';
CREATE TABLE task_artifacts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_id TEXT, kind TEXT NOT NULL,
  reference TEXT NOT NULL, version INTEGER NOT NULL, content_hash TEXT, description TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX artifacts_task ON task_artifacts(task_id);
CREATE TABLE task_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_id TEXT,
  check_name TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX evidence_task ON task_evidence(task_id);
CREATE TABLE coordination_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, root_id TEXT NOT NULL, task_id TEXT, actor TEXT NOT NULL,
  event_type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, published INTEGER NOT NULL DEFAULT 0);
CREATE INDEX events_unpublished ON coordination_events(seq) WHERE published=0;
CREATE INDEX events_root ON coordination_events(root_id, seq);
CREATE TABLE root_usage (
  root_id TEXT PRIMARY KEY, dispatches INTEGER NOT NULL DEFAULT 0, dispatch_limit INTEGER NOT NULL,
  tool_actions INTEGER NOT NULL DEFAULT 0, tool_action_limit INTEGER NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0, message_limit INTEGER NOT NULL, started_at INTEGER NOT NULL, deadline INTEGER NOT NULL);
CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY, root_id TEXT NOT NULL, task_id TEXT NOT NULL, thread TEXT NOT NULL, sender TEXT NOT NULL,
  sender_instance TEXT NOT NULL, kind TEXT NOT NULL, recipients TEXT NOT NULL, group_id TEXT, body TEXT NOT NULL,
  artifacts TEXT NOT NULL, correlation_id TEXT NOT NULL, causation_id TEXT, depth INTEGER NOT NULL,
  idempotency_key TEXT, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX messages_idem ON agent_messages(sender, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX messages_dedupe ON agent_messages(root_id, sender, kind);
CREATE INDEX messages_task ON agent_messages(task_id, created_at);
CREATE TABLE message_deliveries (
  message_id TEXT NOT NULL REFERENCES agent_messages(id), recipient TEXT NOT NULL, root_id TEXT NOT NULL,
  task_id TEXT NOT NULL, state TEXT NOT NULL, wake INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, PRIMARY KEY(message_id, recipient));
CREATE INDEX deliveries_recipient ON message_deliveries(recipient, root_id, state);
CREATE INDEX deliveries_wake ON message_deliveries(state, wake) WHERE wake=1 AND state='queued';
CREATE TABLE dynamic_groups (
  id TEXT PRIMARY KEY, root_id TEXT NOT NULL, task_id TEXT NOT NULL, purpose TEXT NOT NULL, purpose_key TEXT NOT NULL,
  membership_key TEXT NOT NULL, creator TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX groups_reuse ON dynamic_groups(root_id, purpose_key, membership_key) WHERE active=1;
CREATE INDEX groups_root ON dynamic_groups(root_id);
CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES dynamic_groups(id), persona TEXT NOT NULL, role TEXT NOT NULL,
  added_revision INTEGER NOT NULL, removed_revision INTEGER, PRIMARY KEY(group_id, persona, added_revision));
CREATE INDEX group_members_persona ON group_members(persona) WHERE removed_revision IS NULL;
CREATE TABLE task_decisions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), text TEXT NOT NULL, proposer TEXT NOT NULL,
  source_message TEXT, state TEXT NOT NULL, decided_by TEXT, created_at INTEGER NOT NULL);
CREATE INDEX decisions_task ON task_decisions(task_id, state);
PRAGMA user_version=1;";

pub struct CoordinationStore {
    connection: Mutex<Connection>,
    clock: AtomicI64,
}

impl CoordinationStore {
    pub fn open(path: impl AsRef<Path>) -> CoordResult<Self> {
        let connection = Connection::open(path.as_ref())
            .map_err(|e| CoordError::Internal(format!("opening coordination database: {e}")))?;
        connection
            .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0))?;
        Self::from_connection(connection)
    }

    pub fn in_memory() -> CoordResult<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> CoordResult<Self> {
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.set_prepared_statement_cache_capacity(96);
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version < 1 {
            connection.execute_batch(&format!("BEGIN IMMEDIATE;{SCHEMA_V1}COMMIT;"))?;
        }
        Ok(Self {
            connection: Mutex::new(connection),
            clock: AtomicI64::new(0),
        })
    }

    /// Unix seconds; tests may pin the clock to exercise lease expiry.
    pub fn now(&self) -> i64 {
        match self.clock.load(Ordering::Relaxed) {
            0 => std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64,
            pinned => pinned,
        }
    }

    #[cfg(test)]
    pub fn pin_clock(&self, seconds: i64) {
        self.clock.store(seconds, Ordering::Relaxed);
    }

    pub fn read<T>(&self, f: impl FnOnce(&Db<'_>) -> CoordResult<T>) -> CoordResult<T> {
        block(|| {
            let connection = self.connection.lock();
            f(&Db {
                c: &connection,
                now: self.now(),
            })
        })
    }

    /// Runs `f` in one immediate transaction; an `Err` rolls everything back.
    pub fn write<T>(&self, f: impl FnOnce(&Db<'_>) -> CoordResult<T>) -> CoordResult<T> {
        block(|| {
            let mut connection = self.connection.lock();
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let out = f(&Db {
                c: &tx,
                now: self.now(),
            })?;
            tx.commit()?;
            Ok(out)
        })
    }
}

/// Statement helpers over one connection or transaction.
pub struct Db<'a> {
    c: &'a Connection,
    pub now: i64,
}

fn json<T: DeserializeOwned>(text: String) -> rusqlite::Result<T> {
    serde_json::from_str(&text).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn parse<T>(text: String, parser: fn(&str) -> Option<T>) -> rusqlite::Result<T> {
    parser(&text).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!("unknown value {text}").into(),
        )
    })
}

fn dump<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

const TASK_COLS: &str = "id,root_id,parent_id,depth,kind,objective,acceptance,capabilities,workspace,coordinator,owner,reviewer,status,status_reason,revision,paused,feedback,created_at,updated_at";

fn task_row(r: &Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        root_id: r.get(1)?,
        parent_id: r.get(2)?,
        depth: r.get(3)?,
        kind: parse(r.get(4)?, TaskKind::parse)?,
        objective: r.get(5)?,
        acceptance: json(r.get(6)?)?,
        capabilities: json(r.get(7)?)?,
        workspace: r.get(8)?,
        coordinator: r.get(9)?,
        owner: r.get(10)?,
        reviewer: r.get(11)?,
        status: parse(r.get(12)?, TaskStatus::parse)?,
        status_reason: r.get(13)?,
        revision: r.get(14)?,
        paused: r.get::<_, i64>(15)? != 0,
        feedback: json(r.get(16)?)?,
        prerequisites: Vec::new(),
        created_at: r.get(17)?,
        updated_at: r.get(18)?,
    })
}

const ATTEMPT_COLS: &str = "id,task_id,kind,persona,instance_id,runtime_epoch,dispatch_id,fencing,lease_expires_at,heartbeat_at,state,failure_class,failure_detail,worktree,branch,context_metrics,started_at,ended_at";

fn attempt_row(r: &Row<'_>) -> rusqlite::Result<Attempt> {
    Ok(Attempt {
        id: r.get(0)?,
        task_id: r.get(1)?,
        kind: parse(r.get(2)?, AttemptKind::parse)?,
        persona: r.get(3)?,
        instance_id: r.get(4)?,
        runtime_epoch: r.get(5)?,
        dispatch_id: r.get(6)?,
        fencing: r.get(7)?,
        lease_expires_at: r.get(8)?,
        heartbeat_at: r.get(9)?,
        state: parse(r.get(10)?, AttemptState::parse)?,
        failure_class: r.get(11)?,
        failure_detail: r.get(12)?,
        worktree: r.get(13)?,
        branch: r.get(14)?,
        context_metrics: r.get::<_, Option<String>>(15)?.map(json).transpose()?,
        started_at: r.get(16)?,
        ended_at: r.get(17)?,
    })
}

const MESSAGE_COLS: &str = "id,root_id,task_id,thread,sender,sender_instance,kind,recipients,group_id,body,artifacts,correlation_id,causation_id,depth,created_at";

fn message_row(r: &Row<'_>) -> rusqlite::Result<Message> {
    Ok(Message {
        id: r.get(0)?,
        root_id: r.get(1)?,
        task_id: r.get(2)?,
        thread: r.get(3)?,
        sender: r.get(4)?,
        sender_instance: r.get(5)?,
        kind: parse(r.get(6)?, MessageKind::parse)?,
        recipients: json(r.get(7)?)?,
        group_id: r.get(8)?,
        body: r.get(9)?,
        artifacts: json(r.get(10)?)?,
        correlation_id: r.get(11)?,
        causation_id: r.get(12)?,
        depth: r.get(13)?,
        created_at: r.get(14)?,
    })
}

fn delivery_row(r: &Row<'_>) -> rusqlite::Result<Delivery> {
    Ok(Delivery {
        message_id: r.get(0)?,
        recipient: r.get(1)?,
        state: parse(r.get(2)?, DeliveryState::parse)?,
        wake: r.get::<_, i64>(3)? != 0,
        attempts: r.get(4)?,
        updated_at: r.get(5)?,
    })
}

pub struct NewTask {
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
    pub reason: Option<String>,
    pub idempotency_key: Option<String>,
}

#[derive(Default)]
pub struct TaskFilter<'a> {
    pub root: Option<&'a str>,
    pub status: Option<TaskStatus>,
    pub owner: Option<&'a str>,
    pub roots_only: bool,
    /// Keyset cursor: return tasks created strictly after this task id.
    pub after: Option<&'a str>,
    pub limit: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Charge {
    Dispatch,
    ToolAction,
    Message,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Charged {
    Ok,
    Exhausted(String),
}

pub struct NewMessage<'a> {
    pub id: String,
    pub root_id: &'a str,
    pub task_id: &'a str,
    pub sender: &'a str,
    pub sender_instance: &'a str,
    pub kind: MessageKind,
    pub recipients: &'a [String],
    pub group_id: Option<&'a str>,
    pub body: &'a str,
    pub artifacts: &'a [String],
    pub causation_id: Option<&'a str>,
    pub depth: u32,
    pub correlation_id: String,
    pub thread: String,
    pub idempotency_key: Option<&'a str>,
    pub wake: bool,
}

impl Db<'_> {
    // ---- tasks ----
    pub fn insert_task(&self, t: &NewTask) -> CoordResult<()> {
        self.c
            .prepare_cached("INSERT INTO tasks(id,root_id,parent_id,depth,kind,objective,acceptance,capabilities,workspace,coordinator,owner,reviewer,status,status_reason,revision,paused,feedback,idempotency_key,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,1,0,'[]',?15,?16,?16)")?
            .execute(params![t.id, t.root_id, t.parent_id, t.depth, t.kind.as_str(), t.objective, dump(&t.acceptance), dump(&t.capabilities), t.workspace, t.coordinator, t.owner, t.reviewer, t.status.as_str(), t.reason, t.idempotency_key, self.now])?;
        Ok(())
    }

    pub fn task(&self, id: &str) -> CoordResult<Option<Task>> {
        let mut task = self
            .c
            .prepare_cached(&format!("SELECT {TASK_COLS} FROM tasks WHERE id=?1"))?
            .query_row([id], task_row)
            .optional()?;
        if let Some(task) = &mut task {
            task.prerequisites = self.prerequisite_ids(&task.id)?;
        }
        Ok(task)
    }

    pub fn task_or_err(&self, id: &str) -> CoordResult<Task> {
        self.task(id)?
            .ok_or_else(|| CoordError::NotFound(format!("task '{id}' was not found")))
    }

    pub fn task_by_key(&self, key: &str) -> CoordResult<Option<Task>> {
        let id: Option<String> = self
            .c
            .prepare_cached("SELECT id FROM tasks WHERE idempotency_key=?1")?
            .query_row([key], |r| r.get(0))
            .optional()?;
        id.map(|id| self.task_or_err(&id)).transpose()
    }

    pub fn list_tasks(&self, filter: &TaskFilter<'_>) -> CoordResult<Vec<Task>> {
        let mut sql = format!("SELECT {TASK_COLS} FROM tasks WHERE 1=1");
        let mut args: Vec<String> = Vec::new();
        for (clause, value) in [
            (" AND root_id=?", filter.root.map(str::to_owned)),
            (
                " AND status=?",
                filter.status.map(|s| s.as_str().to_owned()),
            ),
            (" AND owner=?", filter.owner.map(str::to_owned)),
            (" AND id>?", filter.after.map(str::to_owned)),
        ] {
            if let Some(value) = value {
                sql.push_str(clause);
                args.push(value);
            }
        }
        if filter.roots_only {
            sql.push_str(" AND id=root_id");
        }
        sql.push_str(&format!(
            " ORDER BY id LIMIT {}",
            filter.limit.clamp(1, 500)
        ));
        let mut tasks = self
            .c
            .prepare_cached(&sql)?
            .query_map(rusqlite::params_from_iter(args.iter()), task_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for task in &mut tasks {
            task.prerequisites = self.prerequisite_ids(&task.id)?;
        }
        Ok(tasks)
    }

    pub fn tasks_with_status(&self, status: TaskStatus, limit: usize) -> CoordResult<Vec<Task>> {
        self.list_tasks(&TaskFilter {
            status: Some(status),
            limit,
            ..Default::default()
        })
    }

    pub fn count_tasks(&self, root: &str) -> CoordResult<usize> {
        Ok(self
            .c
            .prepare_cached("SELECT COUNT(*) FROM tasks WHERE root_id=?1")?
            .query_row([root], |r| r.get::<_, i64>(0))? as usize)
    }

    /// Guarded lifecycle transition: illegal moves and stale revisions fail.
    pub fn set_status(
        &self,
        id: &str,
        next: TaskStatus,
        reason: Option<&str>,
        actor: &str,
        expected_revision: Option<i64>,
    ) -> CoordResult<Task> {
        let task = self.task_or_err(id)?;
        if let Some(expected) = expected_revision {
            if expected != task.revision {
                return Err(CoordError::Conflict(format!(
                    "task '{id}' is at revision {}, not {expected}",
                    task.revision
                )));
            }
        }
        if !task.status.can_transition_to(next) {
            return Err(CoordError::Conflict(format!(
                "task '{id}' cannot move from {} to {}",
                task.status.as_str(),
                next.as_str()
            )));
        }
        self.c
            .prepare_cached("UPDATE tasks SET status=?2,status_reason=?3,revision=revision+1,updated_at=?4 WHERE id=?1")?
            .execute(params![id, next.as_str(), reason, self.now])?;
        self.event(&task.root_id, Some(id), actor, "task.status_changed", serde_json::json!({"from": task.status.as_str(), "to": next.as_str(), "reason": reason}))?;
        self.task_or_err(id)
    }

    pub fn set_owner(&self, id: &str, owner: &str, reviewer: Option<&str>) -> CoordResult<()> {
        self.c.prepare_cached("UPDATE tasks SET owner=?2,reviewer=COALESCE(?3,reviewer),revision=revision+1,updated_at=?4 WHERE id=?1")?.execute(params![id, owner, reviewer, self.now])?;
        Ok(())
    }

    pub fn set_paused(&self, id: &str, paused: bool) -> CoordResult<()> {
        self.c
            .prepare_cached(
                "UPDATE tasks SET paused=?2,revision=revision+1,updated_at=?3 WHERE id=?1",
            )?
            .execute(params![id, paused as i64, self.now])?;
        Ok(())
    }

    pub fn push_feedback(&self, id: &str, note: &str) -> CoordResult<()> {
        let task = self.task_or_err(id)?;
        let mut feedback = task.feedback;
        feedback.push(note.to_owned());
        let keep = feedback.len().saturating_sub(8);
        self.c
            .prepare_cached("UPDATE tasks SET feedback=?2,updated_at=?3 WHERE id=?1")?
            .execute(params![id, dump(&feedback[keep..].to_vec()), self.now])?;
        Ok(())
    }

    pub fn add_dependency(
        &self,
        task: &str,
        prerequisite: &str,
        contract: Option<&str>,
    ) -> CoordResult<()> {
        self.c.prepare_cached("INSERT OR IGNORE INTO task_dependencies(task_id,prerequisite_id,contract) VALUES(?1,?2,?3)")?.execute(params![task, prerequisite, contract])?;
        Ok(())
    }

    pub fn prerequisite_ids(&self, task: &str) -> CoordResult<Vec<String>> {
        Ok(self.c.prepare_cached("SELECT prerequisite_id FROM task_dependencies WHERE task_id=?1 ORDER BY prerequisite_id")?.query_map([task], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?)
    }

    /// `(prerequisite, contract)` pairs for a task.
    pub fn prerequisites(&self, task: &str) -> CoordResult<Vec<(String, Option<String>)>> {
        Ok(self.c.prepare_cached("SELECT prerequisite_id,contract FROM task_dependencies WHERE task_id=?1 ORDER BY prerequisite_id")?.query_map([task], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?)
    }

    pub fn dependants(&self, prerequisite: &str) -> CoordResult<Vec<String>> {
        Ok(self
            .c
            .prepare_cached(
                "SELECT task_id FROM task_dependencies WHERE prerequisite_id=?1 ORDER BY task_id",
            )?
            .query_map([prerequisite], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// Non-terminal tasks per owner: the "active assignment count" for selection.
    pub fn active_load(&self) -> CoordResult<HashMap<String, u32>> {
        let mut statement = self.c.prepare_cached("SELECT owner,COUNT(*) FROM tasks WHERE owner IS NOT NULL AND status NOT IN ('completed','failed','cancelled') GROUP BY owner")?;
        let rows =
            statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    // ---- attempts ----
    pub fn insert_attempt(&self, a: &Attempt) -> CoordResult<()> {
        self.c
            .prepare_cached("INSERT INTO task_attempts(id,task_id,kind,persona,instance_id,runtime_epoch,dispatch_id,fencing,lease_expires_at,heartbeat_at,state,worktree,branch,started_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'running',?11,?12,?13)")?
            .execute(params![a.id, a.task_id, a.kind.as_str(), a.persona, a.instance_id, a.runtime_epoch, a.dispatch_id, a.fencing, a.lease_expires_at, a.heartbeat_at, a.worktree, a.branch, a.started_at])
            .map_err(|e| match e {
                rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
                    CoordError::Conflict(format!("persona '{}' already has a running attempt on task '{}'", a.persona, a.task_id))
                }
                other => other.into(),
            })?;
        Ok(())
    }

    pub fn attempt(&self, id: &str) -> CoordResult<Option<Attempt>> {
        Ok(self
            .c
            .prepare_cached(&format!(
                "SELECT {ATTEMPT_COLS} FROM task_attempts WHERE id=?1"
            ))?
            .query_row([id], attempt_row)
            .optional()?)
    }

    pub fn running_attempt(&self, task: &str, persona: &str) -> CoordResult<Option<Attempt>> {
        Ok(self.c.prepare_cached(&format!("SELECT {ATTEMPT_COLS} FROM task_attempts WHERE task_id=?1 AND persona=?2 AND state='running'"))?.query_row(params![task, persona], attempt_row).optional()?)
    }

    pub fn running_attempts(&self, task: Option<&str>) -> CoordResult<Vec<Attempt>> {
        let sql = format!("SELECT {ATTEMPT_COLS} FROM task_attempts WHERE state='running' AND (?1 IS NULL OR task_id=?1) ORDER BY started_at");
        Ok(self
            .c
            .prepare_cached(&sql)?
            .query_map([task], attempt_row)?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn attempts_for_task(&self, task: &str, limit: usize) -> CoordResult<Vec<Attempt>> {
        let sql = format!("SELECT {ATTEMPT_COLS} FROM task_attempts WHERE task_id=?1 ORDER BY started_at,id LIMIT {}", limit.clamp(1, 200));
        Ok(self
            .c
            .prepare_cached(&sql)?
            .query_map([task], attempt_row)?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn attempt_count(&self, task: &str) -> CoordResult<u32> {
        Ok(self
            .c
            .prepare_cached(
                "SELECT COUNT(*) FROM task_attempts WHERE task_id=?1 AND kind IN ('work','plan')",
            )?
            .query_row([task], |r| r.get(0))?)
    }

    pub fn next_fencing(&self, task: &str) -> CoordResult<i64> {
        Ok(self
            .c
            .prepare_cached(
                "SELECT COALESCE(MAX(fencing),0)+1 FROM task_attempts WHERE task_id=?1",
            )?
            .query_row([task], |r| r.get(0))?)
    }

    pub fn expired_attempts(&self) -> CoordResult<Vec<Attempt>> {
        Ok(self.c.prepare_cached(&format!("SELECT {ATTEMPT_COLS} FROM task_attempts WHERE state='running' AND lease_expires_at<?1"))?.query_map([self.now], attempt_row)?.collect::<rusqlite::Result<_>>()?)
    }

    pub fn heartbeat(&self, id: &str, lease_secs: i64) -> CoordResult<bool> {
        Ok(self.c.prepare_cached("UPDATE task_attempts SET heartbeat_at=?2,lease_expires_at=?3 WHERE id=?1 AND state='running'")?.execute(params![id, self.now, self.now + lease_secs])? > 0)
    }

    pub fn finish_attempt(
        &self,
        id: &str,
        state: AttemptState,
        class: Option<&str>,
        detail: Option<&str>,
    ) -> CoordResult<bool> {
        Ok(self.c.prepare_cached("UPDATE task_attempts SET state=?2,failure_class=?3,failure_detail=?4,ended_at=?5 WHERE id=?1 AND state='running'")?.execute(params![id, state.as_str(), class, detail, self.now])? > 0)
    }

    pub fn set_attempt_epoch(&self, id: &str, epoch: &str) -> CoordResult<()> {
        self.c
            .prepare_cached("UPDATE task_attempts SET runtime_epoch=?2 WHERE id=?1")?
            .execute(params![id, epoch])?;
        Ok(())
    }

    pub fn set_attempt_workspace(
        &self,
        id: &str,
        worktree: Option<&str>,
        branch: Option<&str>,
    ) -> CoordResult<()> {
        self.c
            .prepare_cached("UPDATE task_attempts SET worktree=?2,branch=?3 WHERE id=?1")?
            .execute(params![id, worktree, branch])?;
        Ok(())
    }

    pub fn set_attempt_metrics(&self, id: &str, metrics: &serde_json::Value) -> CoordResult<()> {
        self.c
            .prepare_cached("UPDATE task_attempts SET context_metrics=?2 WHERE id=?1")?
            .execute(params![id, dump(metrics)])?;
        Ok(())
    }

    // ---- artifacts and evidence ----
    pub fn add_artifact(
        &self,
        task: &str,
        attempt: Option<&str>,
        kind: &str,
        reference: &str,
        hash: Option<&str>,
        description: &str,
    ) -> CoordResult<Artifact> {
        let version: i64 = self.c.prepare_cached("SELECT COALESCE(MAX(version),0)+1 FROM task_artifacts WHERE task_id=?1 AND kind=?2 AND reference=?3")?.query_row(params![task, kind, reference], |r| r.get(0))?;
        let id = new_id("ar");
        self.c.prepare_cached("INSERT INTO task_artifacts(id,task_id,attempt_id,kind,reference,version,content_hash,description,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)")?.execute(params![id, task, attempt, kind, reference, version, hash, description, self.now])?;
        Ok(Artifact {
            id,
            task_id: task.into(),
            attempt_id: attempt.map(str::to_owned),
            kind: kind.into(),
            reference: reference.into(),
            version,
            content_hash: hash.map(str::to_owned),
            description: description.into(),
            created_at: self.now,
        })
    }

    fn artifact_row(r: &Row<'_>) -> rusqlite::Result<Artifact> {
        Ok(Artifact {
            id: r.get(0)?,
            task_id: r.get(1)?,
            attempt_id: r.get(2)?,
            kind: r.get(3)?,
            reference: r.get(4)?,
            version: r.get(5)?,
            content_hash: r.get(6)?,
            description: r.get(7)?,
            created_at: r.get(8)?,
        })
    }

    pub fn artifact(&self, id: &str) -> CoordResult<Option<Artifact>> {
        Ok(self.c.prepare_cached("SELECT id,task_id,attempt_id,kind,reference,version,content_hash,description,created_at FROM task_artifacts WHERE id=?1")?.query_row([id], Self::artifact_row).optional()?)
    }

    pub fn artifacts(&self, task: &str) -> CoordResult<Vec<Artifact>> {
        Ok(self.c.prepare_cached("SELECT id,task_id,attempt_id,kind,reference,version,content_hash,description,created_at FROM task_artifacts WHERE task_id=?1 ORDER BY created_at,id LIMIT 100")?.query_map([task], Self::artifact_row)?.collect::<rusqlite::Result<_>>()?)
    }

    pub fn add_evidence(
        &self,
        task: &str,
        attempt: Option<&str>,
        evidence: &Evidence,
    ) -> CoordResult<()> {
        self.c.prepare_cached("INSERT INTO task_evidence(task_id,attempt_id,check_name,outcome,detail,created_at) VALUES(?1,?2,?3,?4,?5,?6)")?.execute(params![task, attempt, evidence.check, evidence.outcome.as_str(), evidence.detail, self.now])?;
        Ok(())
    }

    /// Evidence from the newest attempt that submitted any.
    pub fn latest_evidence(&self, task: &str) -> CoordResult<Vec<Evidence>> {
        let mut statement = self.c.prepare_cached("SELECT check_name,outcome,detail FROM task_evidence WHERE task_id=?1 AND attempt_id IS (SELECT attempt_id FROM task_evidence WHERE task_id=?1 ORDER BY id DESC LIMIT 1) ORDER BY id LIMIT 50")?;
        let rows = statement.query_map([task], |r| {
            Ok(Evidence {
                check: r.get(0)?,
                outcome: parse(r.get(1)?, Verdict::parse)?,
                detail: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Whether `persona` coordinates, owns, or reviews any task of `root`, or
    /// belongs to one of its active groups.
    pub fn is_participant(&self, root: &str, persona: &str) -> CoordResult<bool> {
        let task = self.c.prepare_cached("SELECT 1 FROM tasks WHERE root_id=?1 AND (coordinator=?2 OR owner=?2 OR reviewer=?2) LIMIT 1")?.query_row(params![root, persona], |_| Ok(())).optional()?.is_some();
        if task {
            return Ok(true);
        }
        Ok(self.c.prepare_cached("SELECT 1 FROM dynamic_groups g JOIN group_members m ON m.group_id=g.id WHERE g.root_id=?1 AND g.active=1 AND m.persona=?2 AND m.removed_revision IS NULL LIMIT 1")?.query_row(params![root, persona], |_| Ok(())).optional()?.is_some())
    }

    pub fn task_ids(&self, root: &str) -> CoordResult<Vec<String>> {
        Ok(self
            .c
            .prepare_cached("SELECT id FROM tasks WHERE root_id=?1 ORDER BY id LIMIT 1000")?
            .query_map([root], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn children(&self, parent: &str) -> CoordResult<Vec<Task>> {
        let ids: Vec<String> = self
            .c
            .prepare_cached("SELECT id FROM tasks WHERE parent_id=?1 ORDER BY id LIMIT 500")?
            .query_map([parent], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        ids.iter().map(|id| self.task_or_err(id)).collect()
    }

    /// Whether the persona's most recently started attempt failed.
    pub fn latest_attempt_failed(&self, persona: &str) -> CoordResult<bool> {
        let state: Option<String> = self.c.prepare_cached("SELECT state FROM task_attempts WHERE persona=?1 ORDER BY started_at DESC, id DESC LIMIT 1")?.query_row([persona], |r| r.get(0)).optional()?;
        Ok(state.as_deref() == Some("failed"))
    }

    // ---- events ----
    pub fn event(
        &self,
        root: &str,
        task: Option<&str>,
        actor: &str,
        event_type: &str,
        payload: serde_json::Value,
    ) -> CoordResult<i64> {
        self.c.prepare_cached("INSERT INTO coordination_events(root_id,task_id,actor,event_type,payload,created_at) VALUES(?1,?2,?3,?4,?5,?6)")?.execute(params![root, task, actor, event_type, dump(&payload), self.now])?;
        Ok(self.c.last_insert_rowid())
    }

    fn event_row(r: &Row<'_>) -> rusqlite::Result<CoordinationEvent> {
        Ok(CoordinationEvent {
            seq: r.get(0)?,
            root_id: r.get(1)?,
            task_id: r.get(2)?,
            actor: r.get(3)?,
            event_type: r.get(4)?,
            payload: json(r.get(5)?)?,
            created_at: r.get(6)?,
        })
    }

    pub fn unpublished_events(&self, limit: usize) -> CoordResult<Vec<CoordinationEvent>> {
        Ok(self.c.prepare_cached("SELECT seq,root_id,task_id,actor,event_type,payload,created_at FROM coordination_events WHERE published=0 ORDER BY seq LIMIT ?1")?.query_map([limit as i64], Self::event_row)?.collect::<rusqlite::Result<_>>()?)
    }

    pub fn mark_published(&self, upto: i64) -> CoordResult<()> {
        self.c
            .prepare_cached(
                "UPDATE coordination_events SET published=1 WHERE published=0 AND seq<=?1",
            )?
            .execute([upto])?;
        Ok(())
    }

    /// Events with `seq > after`, optionally for one root, bounded by `limit`.
    pub fn events_after(
        &self,
        after: i64,
        root: Option<&str>,
        limit: usize,
    ) -> CoordResult<Vec<CoordinationEvent>> {
        Ok(self.c.prepare_cached("SELECT seq,root_id,task_id,actor,event_type,payload,created_at FROM coordination_events WHERE seq>?1 AND (?2 IS NULL OR root_id=?2) ORDER BY seq LIMIT ?3")?.query_map(params![after, root, limit.clamp(1, 500) as i64], Self::event_row)?.collect::<rusqlite::Result<_>>()?)
    }

    pub fn max_event_seq(&self) -> CoordResult<i64> {
        Ok(self
            .c
            .prepare_cached("SELECT COALESCE(MAX(seq),0) FROM coordination_events")?
            .query_row([], |r| r.get(0))?)
    }

    // ---- budgets ----
    pub fn init_usage(
        &self,
        root: &str,
        dispatches: u32,
        actions: u32,
        messages: u32,
        max_elapsed: u64,
    ) -> CoordResult<()> {
        self.c.prepare_cached("INSERT INTO root_usage(root_id,dispatch_limit,tool_action_limit,message_limit,started_at,deadline) VALUES(?1,?2,?3,?4,?5,?6)")?.execute(params![root, dispatches, actions, messages, self.now, self.now + max_elapsed as i64])?;
        Ok(())
    }

    pub fn usage(&self, root: &str) -> CoordResult<Option<Usage>> {
        Ok(self
            .c
            .prepare_cached("SELECT dispatches,dispatch_limit,tool_actions,tool_action_limit,messages,message_limit,started_at,deadline FROM root_usage WHERE root_id=?1")?
            .query_row([root], |r| {
                Ok(Usage { dispatches: r.get(0)?, dispatch_limit: r.get(1)?, tool_actions: r.get(2)?, tool_action_limit: r.get(3)?, messages: r.get(4)?, message_limit: r.get(5)?, started_at: r.get(6)?, deadline: r.get(7)?, tokens: None })
            })
            .optional()?)
    }

    /// Charges one unit against the root; exhausted budgets are reported, not counted.
    pub fn charge(&self, root: &str, what: Charge) -> CoordResult<Charged> {
        let usage = self.usage(root)?.ok_or_else(|| {
            CoordError::NotFound(format!("root task '{root}' has no budget record"))
        })?;
        if self.now > usage.deadline {
            return Ok(Charged::Exhausted("elapsed time limit reached".into()));
        }
        let (column, used, limit, label) = match what {
            Charge::Dispatch => (
                "dispatches",
                usage.dispatches,
                usage.dispatch_limit,
                "dispatch limit",
            ),
            Charge::ToolAction => (
                "tool_actions",
                usage.tool_actions,
                usage.tool_action_limit,
                "tool action limit",
            ),
            Charge::Message => (
                "messages",
                usage.messages,
                usage.message_limit,
                "message limit",
            ),
        };
        if used >= limit {
            return Ok(Charged::Exhausted(format!("{label} ({limit}) reached")));
        }
        self.c.execute(
            &format!("UPDATE root_usage SET {column}={column}+1 WHERE root_id=?1"),
            [root],
        )?;
        Ok(Charged::Ok)
    }

    pub fn extend_usage(&self, root: &str, dispatches: u32, seconds: u64) -> CoordResult<()> {
        self.c.prepare_cached("UPDATE root_usage SET dispatch_limit=dispatch_limit+?2, tool_action_limit=tool_action_limit+?2*4, message_limit=message_limit+?2*2, deadline=MAX(deadline,?4)+?3 WHERE root_id=?1")?.execute(params![root, dispatches, seconds as i64, self.now])?;
        Ok(())
    }

    // ---- messages ----
    pub fn insert_message(&self, m: &NewMessage<'_>) -> CoordResult<()> {
        self.c
            .prepare_cached("INSERT INTO agent_messages(id,root_id,task_id,thread,sender,sender_instance,kind,recipients,group_id,body,artifacts,correlation_id,causation_id,depth,idempotency_key,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)")?
            .execute(params![m.id, m.root_id, m.task_id, m.thread, m.sender, m.sender_instance, m.kind.as_str(), dump(&m.recipients), m.group_id, m.body, dump(&m.artifacts), m.correlation_id, m.causation_id, m.depth, m.idempotency_key, self.now])?;
        for recipient in m.recipients {
            self.c
                .prepare_cached("INSERT INTO message_deliveries(message_id,recipient,root_id,task_id,state,wake,updated_at) VALUES(?1,?2,?3,?4,'queued',?5,?6)")?
                .execute(params![m.id, recipient, m.root_id, m.task_id, m.wake as i64, self.now])?;
        }
        Ok(())
    }

    pub fn message(&self, id: &str) -> CoordResult<Option<Message>> {
        Ok(self
            .c
            .prepare_cached(&format!(
                "SELECT {MESSAGE_COLS} FROM agent_messages WHERE id=?1"
            ))?
            .query_row([id], message_row)
            .optional()?)
    }

    pub fn message_by_key(&self, sender: &str, key: &str) -> CoordResult<Option<Message>> {
        Ok(self
            .c
            .prepare_cached(&format!(
                "SELECT {MESSAGE_COLS} FROM agent_messages WHERE sender=?1 AND idempotency_key=?2"
            ))?
            .query_row(params![sender, key], message_row)
            .optional()?)
    }

    /// An identical earlier message (same sender, kind, task, audience, body).
    #[allow(clippy::too_many_arguments)]
    pub fn equivalent_message(
        &self,
        root: &str,
        task: &str,
        sender: &str,
        kind: MessageKind,
        recipients: &[String],
        group: Option<&str>,
        body: &str,
    ) -> CoordResult<Option<Message>> {
        let mut statement = self.c.prepare_cached(&format!("SELECT {MESSAGE_COLS} FROM agent_messages WHERE root_id=?1 AND sender=?2 AND kind=?3 ORDER BY created_at DESC, id DESC LIMIT 50"))?;
        let rows = statement.query_map(params![root, sender, kind.as_str()], message_row)?;
        for row in rows {
            let message = row?;
            if message.task_id == task
                && message.body == body
                && message.recipients == recipients
                && message.group_id.as_deref() == group
            {
                return Ok(Some(message));
            }
        }
        Ok(None)
    }

    pub fn message_count_for(&self, task: &str) -> CoordResult<i64> {
        Ok(self
            .c
            .prepare_cached("SELECT COUNT(*) FROM agent_messages WHERE task_id=?1")?
            .query_row([task], |r| r.get(0))?)
    }

    pub fn list_messages(
        &self,
        root: &str,
        task: Option<&str>,
        after: Option<&str>,
        limit: usize,
    ) -> CoordResult<Vec<Message>> {
        let sql = format!("SELECT {MESSAGE_COLS} FROM agent_messages WHERE root_id=?1 AND (?2 IS NULL OR task_id=?2) AND (?3 IS NULL OR id>?3) ORDER BY id LIMIT {}", limit.clamp(1, 200));
        Ok(self
            .c
            .prepare_cached(&sql)?
            .query_map(params![root, task, after], message_row)?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn delivery(&self, message: &str, recipient: &str) -> CoordResult<Option<Delivery>> {
        Ok(self.c.prepare_cached("SELECT message_id,recipient,state,wake,attempts,updated_at FROM message_deliveries WHERE message_id=?1 AND recipient=?2")?.query_row(params![message, recipient], delivery_row).optional()?)
    }

    pub fn deliveries_of(&self, message: &str) -> CoordResult<Vec<Delivery>> {
        Ok(self.c.prepare_cached("SELECT message_id,recipient,state,wake,attempts,updated_at FROM message_deliveries WHERE message_id=?1 ORDER BY recipient")?.query_map([message], delivery_row)?.collect::<rusqlite::Result<_>>()?)
    }

    /// Unacknowledged deliveries for `recipient` in one root, oldest first.
    pub fn inbox(
        &self,
        recipient: &str,
        root: &str,
        states: &[DeliveryState],
        limit: usize,
    ) -> CoordResult<Vec<(Delivery, Message)>> {
        let list = states
            .iter()
            .map(|s| format!("'{}'", s.as_str()))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT d.message_id,d.recipient,d.state,d.wake,d.attempts,d.updated_at FROM message_deliveries d WHERE d.recipient=?1 AND d.root_id=?2 AND d.state IN ({list}) ORDER BY d.message_id LIMIT {}",
            limit.clamp(1, 100)
        );
        let deliveries: Vec<Delivery> = self
            .c
            .prepare_cached(&sql)?
            .query_map(params![recipient, root], delivery_row)?
            .collect::<rusqlite::Result<_>>()?;
        let mut out = Vec::with_capacity(deliveries.len());
        for delivery in deliveries {
            if let Some(message) = self.message(&delivery.message_id)? {
                out.push((delivery, message));
            }
        }
        Ok(out)
    }

    pub fn set_delivery(
        &self,
        message: &str,
        recipient: &str,
        state: DeliveryState,
    ) -> CoordResult<bool> {
        let bump = matches!(state, DeliveryState::Processing) as i64;
        Ok(self.c.prepare_cached("UPDATE message_deliveries SET state=?3,attempts=attempts+?4,updated_at=?5 WHERE message_id=?1 AND recipient=?2 AND state NOT IN ('acknowledged','cancelled')")?.execute(params![message, recipient, state.as_str(), bump, self.now])? > 0)
    }

    /// Queued wake deliveries, oldest first: the actionable work queue.
    pub fn wake_queue(&self, limit: usize) -> CoordResult<Vec<(Delivery, Message)>> {
        let deliveries: Vec<Delivery> = self
            .c
            .prepare_cached("SELECT message_id,recipient,state,wake,attempts,updated_at FROM message_deliveries WHERE state='queued' AND wake=1 ORDER BY message_id LIMIT ?1")?
            .query_map([limit as i64], delivery_row)?
            .collect::<rusqlite::Result<_>>()?;
        let mut out = Vec::with_capacity(deliveries.len());
        for delivery in deliveries {
            if let Some(message) = self.message(&delivery.message_id)? {
                out.push((delivery, message));
            }
        }
        Ok(out)
    }

    pub fn cancel_deliveries(&self, root: &str) -> CoordResult<usize> {
        Ok(self.c.prepare_cached("UPDATE message_deliveries SET state='cancelled',updated_at=?2 WHERE root_id=?1 AND state IN ('queued','delivered','processing')")?.execute(params![root, self.now])?)
    }

    pub fn queued_wakes_for(&self, recipient: &str) -> CoordResult<i64> {
        Ok(self.c.prepare_cached("SELECT COUNT(*) FROM message_deliveries WHERE recipient=?1 AND wake=1 AND state='queued'")?.query_row([recipient], |r| r.get(0))?)
    }

    // ---- groups ----
    #[allow(clippy::too_many_arguments)]
    pub fn insert_group(
        &self,
        id: &str,
        root: &str,
        task: &str,
        purpose: &str,
        purpose_key: &str,
        membership_key: &str,
        creator: &str,
    ) -> CoordResult<()> {
        self.c.prepare_cached("INSERT INTO dynamic_groups(id,root_id,task_id,purpose,purpose_key,membership_key,creator,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)")?.execute(params![id, root, task, purpose, purpose_key, membership_key, creator, self.now])?;
        Ok(())
    }

    pub fn find_reusable_group(
        &self,
        root: &str,
        purpose_key: &str,
        membership_key: &str,
    ) -> CoordResult<Option<String>> {
        Ok(self.c.prepare_cached("SELECT id FROM dynamic_groups WHERE root_id=?1 AND purpose_key=?2 AND membership_key=?3 AND active=1")?.query_row(params![root, purpose_key, membership_key], |r| r.get(0)).optional()?)
    }

    pub fn group(&self, id: &str) -> CoordResult<Option<Group>> {
        let head = self
            .c
            .prepare_cached("SELECT id,root_id,task_id,purpose,creator,active,revision,created_at FROM dynamic_groups WHERE id=?1")?
            .query_row([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, i64>(5)?, r.get::<_, i64>(6)?, r.get::<_, i64>(7)?)))
            .optional()?;
        let Some((id, root_id, task_id, purpose, creator, active, revision, created_at)) = head
        else {
            return Ok(None);
        };
        let members = self.group_members(&id)?;
        Ok(Some(Group {
            id,
            root_id,
            task_id,
            purpose,
            creator,
            active: active != 0,
            revision,
            members,
            created_at,
        }))
    }

    pub fn group_members(&self, group: &str) -> CoordResult<Vec<GroupMember>> {
        Ok(self.c.prepare_cached("SELECT persona,role FROM group_members WHERE group_id=?1 AND removed_revision IS NULL ORDER BY persona")?.query_map([group], |r| Ok(GroupMember { persona: r.get(0)?, role: r.get(1)? }))?.collect::<rusqlite::Result<_>>()?)
    }

    pub fn list_groups(&self, root: &str) -> CoordResult<Vec<Group>> {
        let ids: Vec<String> = self
            .c
            .prepare_cached("SELECT id FROM dynamic_groups WHERE root_id=?1 ORDER BY id LIMIT 100")?
            .query_map([root], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        ids.iter()
            .filter_map(|id| self.group(id).transpose())
            .collect()
    }

    pub fn add_member(
        &self,
        group: &str,
        persona: &str,
        role: &str,
        revision: i64,
    ) -> CoordResult<()> {
        self.c.prepare_cached("INSERT INTO group_members(group_id,persona,role,added_revision) VALUES(?1,?2,?3,?4)")?.execute(params![group, persona, role, revision])?;
        Ok(())
    }

    pub fn remove_member(&self, group: &str, persona: &str, revision: i64) -> CoordResult<bool> {
        Ok(self.c.prepare_cached("UPDATE group_members SET removed_revision=?3 WHERE group_id=?1 AND persona=?2 AND removed_revision IS NULL")?.execute(params![group, persona, revision])? > 0)
    }

    pub fn set_group_revision(
        &self,
        group: &str,
        revision: i64,
        membership_key: &str,
    ) -> CoordResult<()> {
        self.c
            .prepare_cached("UPDATE dynamic_groups SET revision=?2,membership_key=?3 WHERE id=?1")?
            .execute(params![group, revision, membership_key])?;
        Ok(())
    }

    /// Groups of `root` the persona currently belongs to.
    pub fn is_member(&self, group: &str, persona: &str) -> CoordResult<bool> {
        Ok(self.c.prepare_cached("SELECT 1 FROM group_members WHERE group_id=?1 AND persona=?2 AND removed_revision IS NULL")?.query_row(params![group, persona], |_| Ok(())).optional()?.is_some())
    }

    pub fn archive_groups(&self, root: &str) -> CoordResult<usize> {
        Ok(self
            .c
            .prepare_cached("UPDATE dynamic_groups SET active=0 WHERE root_id=?1 AND active=1")?
            .execute([root])?)
    }

    // ---- decisions ----
    pub fn insert_decision(
        &self,
        task: &str,
        text: &str,
        proposer: &str,
        message: Option<&str>,
    ) -> CoordResult<Decision> {
        let id = new_id("dc");
        self.c.prepare_cached("INSERT INTO task_decisions(id,task_id,text,proposer,source_message,state,created_at) VALUES(?1,?2,?3,?4,?5,'proposed',?6)")?.execute(params![id, task, text, proposer, message, self.now])?;
        Ok(Decision {
            id,
            task_id: task.into(),
            text: text.into(),
            proposer: proposer.into(),
            source_message: message.map(str::to_owned),
            state: "proposed".into(),
            created_at: self.now,
        })
    }

    fn decision_row(r: &Row<'_>) -> rusqlite::Result<Decision> {
        Ok(Decision {
            id: r.get(0)?,
            task_id: r.get(1)?,
            text: r.get(2)?,
            proposer: r.get(3)?,
            source_message: r.get(4)?,
            state: r.get(5)?,
            created_at: r.get(6)?,
        })
    }

    pub fn decision(&self, id: &str) -> CoordResult<Option<Decision>> {
        Ok(self.c.prepare_cached("SELECT id,task_id,text,proposer,source_message,state,created_at FROM task_decisions WHERE id=?1")?.query_row([id], Self::decision_row).optional()?)
    }

    pub fn decisions(&self, task: &str, state: Option<&str>) -> CoordResult<Vec<Decision>> {
        Ok(self.c.prepare_cached("SELECT id,task_id,text,proposer,source_message,state,created_at FROM task_decisions WHERE task_id=?1 AND (?2 IS NULL OR state=?2) ORDER BY id LIMIT 50")?.query_map(params![task, state], Self::decision_row)?.collect::<rusqlite::Result<_>>()?)
    }

    pub fn set_decision(&self, id: &str, state: &str, by: &str) -> CoordResult<()> {
        self.c
            .prepare_cached("UPDATE task_decisions SET state=?2,decided_by=?3 WHERE id=?1")?
            .execute(params![id, state, by])?;
        Ok(())
    }
}
