//! SQLite backlog. Filing an issue only writes a row.
use std::{
    path::Path,
    sync::atomic::{AtomicI64, Ordering},
    time::Duration,
};

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};

use super::model::*;

fn block<T>(f: impl FnOnce() -> T) -> T {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(f)
        }
        _ => f(),
    }
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  round_id TEXT NOT NULL,
  dismiss_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS issues_open_title ON issues(title_key) WHERE status='open';
CREATE INDEX IF NOT EXISTS issues_status ON issues(status, created_at);
CREATE INDEX IF NOT EXISTS issues_round ON issues(round_id);
CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  trigger_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  members TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT,
  issue_count INTEGER NOT NULL DEFAULT 0,
  running_slot INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS rounds_one_running ON rounds(running_slot) WHERE status='running';
CREATE INDEX IF NOT EXISTS rounds_started ON rounds(started_at);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
";

pub struct IssueStore {
    connection: Mutex<Connection>,
    clock: AtomicI64,
}

impl IssueStore {
    pub fn open(path: impl AsRef<Path>) -> IssueResult<Self> {
        let connection = Connection::open(path.as_ref()).map_err(|error| {
            IssueError::Internal(format!("opening issue database: {error}"))
        })?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| IssueError::Internal(format!("opening issue database: {error}")))?;
        Self::from_connection(connection)
    }

    pub fn in_memory() -> IssueResult<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> IssueResult<Self> {
        connection.execute_batch(SCHEMA)?;
        Ok(Self {
            connection: Mutex::new(connection),
            clock: AtomicI64::new(0),
        })
    }

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

    fn write<T>(&self, f: impl FnOnce(&Transaction<'_>) -> IssueResult<T>) -> IssueResult<T> {
        block(|| {
            let mut connection = self.connection.lock();
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let result = f(&tx)?;
            tx.commit()?;
            Ok(result)
        })
    }

    fn read<T>(&self, f: impl FnOnce(&Connection) -> IssueResult<T>) -> IssueResult<T> {
        block(|| f(&self.connection.lock()))
    }

    pub fn begin_round(&self, trigger: Trigger, members: &[String]) -> IssueResult<Round> {
        let now = self.now();
        let id = crate::coordination::model::new_id("rnd");
        let members_json = serde_json::to_string(members)
            .map_err(|error| IssueError::Internal(format!("encoding council members: {error}")))?;
        self.write(|tx| {
            match tx.execute(
                "INSERT INTO rounds(id, trigger_kind, status, members, started_at, issue_count, running_slot)
                 VALUES(?1, ?2, 'running', ?3, ?4, 0, 1)",
                params![id, trigger.as_str(), members_json, now],
            ) {
                Ok(_) => {}
                Err(error) if constraint(&error) => {
                    return Err(IssueError::Conflict(
                        "an issue council is already running".into(),
                    ));
                }
                Err(error) => return Err(error.into()),
            }
            round_by_id(tx, &id)?.ok_or_else(|| IssueError::Internal("round insert vanished".into()))
        })
    }

    pub fn finish_round(&self, id: &str, error: Option<String>) -> IssueResult<Option<Round>> {
        let now = self.now();
        let status = if error.is_some() {
            RoundStatus::Failed
        } else {
            RoundStatus::Completed
        };
        self.write(|tx| {
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM issues WHERE round_id=?1",
                [id],
                |row| row.get(0),
            )?;
            let updated = tx.execute(
                "UPDATE rounds SET status=?1, finished_at=?2, error=?3, issue_count=?4
                 WHERE id=?5 AND status='running'",
                params![status.as_str(), now, error, count, id],
            )?;
            if updated == 0 {
                return Ok(None);
            }
            round_by_id(tx, id)
        })
    }

    pub fn interrupt_running(&self) -> IssueResult<u32> {
        let now = self.now();
        self.write(|tx| {
            let updated = tx.execute(
                "UPDATE rounds SET status='failed', finished_at=?1, error='interrupted'
                 WHERE status='running'",
                [now],
            )?;
            Ok(updated as u32)
        })
    }

    pub fn running(&self) -> IssueResult<Option<Round>> {
        self.read(|db| {
            db.query_row(
                "SELECT id, trigger_kind, status, members, started_at, finished_at, error, issue_count
                 FROM rounds WHERE status='running' ORDER BY started_at DESC LIMIT 1",
                [],
                round_from_row,
            )
            .optional()?
            .transpose()
        })
    }

    pub fn round(&self, id: &str) -> IssueResult<Round> {
        self.read(|db| {
            round_by_id(db, id)?.ok_or_else(|| IssueError::NotFound(format!("unknown round {id}")))
        })
    }

    pub fn rounds(&self, limit: usize) -> IssueResult<Vec<Round>> {
        let limit = limit.clamp(1, 100);
        self.read(|db| {
            let mut statement = db.prepare(
                "SELECT id, trigger_kind, status, members, started_at, finished_at, error, issue_count
                 FROM rounds ORDER BY started_at DESC LIMIT ?1",
            )?;
            let rows = statement.query_map([limit as i64], round_from_row)?;
            rows.collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .collect()
        })
    }

    /// Finish time of the latest council, else the persisted cadence start.
    /// The cadence start is written once so a restart does not reset the wait.
    pub fn anchor(&self, now: i64) -> IssueResult<i64> {
        self.write(|tx| {
            if let Some(finished) = tx
                .query_row(
                    "SELECT finished_at FROM rounds
                     WHERE finished_at IS NOT NULL AND status IN ('completed','failed')
                     ORDER BY finished_at DESC LIMIT 1",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
            {
                return Ok(finished);
            }
            tx.execute(
                "INSERT INTO meta(key, value) VALUES('anchor', ?1) ON CONFLICT(key) DO NOTHING",
                [now.to_string()],
            )?;
            let value: String =
                tx.query_row("SELECT value FROM meta WHERE key='anchor'", [], |row| {
                    row.get(0)
                })?;
            value
                .parse()
                .map_err(|_| IssueError::Internal("bad cadence anchor".into()))
        })
    }

    pub fn propose(&self, proposal: Proposal, max_per_round: u32) -> IssueResult<Proposed> {
        let now = self.now();
        self.write(|tx| {
            let round = running_round(tx)?.ok_or_else(|| {
                IssueError::Conflict("no issue council is running".into())
            })?;
            if !round.members.iter().any(|member| member == &proposal.persona) {
                return Err(IssueError::Invalid(
                    "you are not part of this issue council".into(),
                ));
            }
            let key = title_key(&proposal.title);
            if let Some(existing) = open_by_key(tx, &key)? {
                return Ok(Proposed {
                    issue: existing,
                    created: false,
                });
            }
            let filed: i64 = tx.query_row(
                "SELECT COUNT(*) FROM issues WHERE round_id=?1",
                [&round.id],
                |row| row.get(0),
            )?;
            if filed >= i64::from(max_per_round) {
                return Err(IssueError::Conflict(format!(
                    "this round already filed {max_per_round} issues"
                )));
            }
            let id = crate::coordination::model::new_id("iss");
            match tx.execute(
                "INSERT INTO issues(id, kind, title, title_key, body, status, priority, proposed_by, round_id, created_at, updated_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, 'open', ?6, ?7, ?8, ?9, ?9)",
                params![
                    id,
                    proposal.kind.as_str(),
                    proposal.title,
                    key,
                    proposal.body,
                    proposal.priority.as_str(),
                    proposal.persona,
                    round.id,
                    now
                ],
            ) {
                Ok(_) => {}
                Err(error) if constraint(&error) => {
                    if let Some(existing) = open_by_key(tx, &key)? {
                        return Ok(Proposed {
                            issue: existing,
                            created: false,
                        });
                    }
                    return Err(error.into());
                }
                Err(error) => return Err(error.into()),
            }
            let issue = issue_by_id(tx, &id)?
                .ok_or_else(|| IssueError::Internal("issue insert vanished".into()))?;
            Ok(Proposed {
                issue,
                created: true,
            })
        })
    }

    pub fn list(
        &self,
        status: Option<IssueStatus>,
        kind: Option<IssueKind>,
        limit: usize,
    ) -> IssueResult<Vec<Issue>> {
        let limit = limit.clamp(1, 200);
        self.read(|db| {
            let mut statement = db.prepare(
                "SELECT id, kind, title, body, status, priority, proposed_by, round_id, dismiss_reason, created_at, updated_at
                 FROM issues
                 WHERE (?1 IS NULL OR status=?1) AND (?2 IS NULL OR kind=?2)
                 ORDER BY created_at DESC LIMIT ?3",
            )?;
            let rows = statement.query_map(
                params![
                    status.map(|status| status.as_str().to_owned()),
                    kind.map(|kind| kind.as_str().to_owned()),
                    limit as i64
                ],
                issue_from_row,
            )?;
            rows.collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .collect()
        })
    }

    pub fn open_oldest(&self, limit: usize) -> IssueResult<(Vec<Issue>, usize)> {
        let limit = limit.clamp(1, 40);
        self.read(|db| {
            let total: i64 = db.query_row(
                "SELECT COUNT(*) FROM issues WHERE status='open'",
                [],
                |row| row.get(0),
            )?;
            let mut statement = db.prepare(
                "SELECT id, kind, title, body, status, priority, proposed_by, round_id, dismiss_reason, created_at, updated_at
                 FROM issues WHERE status='open' ORDER BY created_at ASC LIMIT ?1",
            )?;
            let rows = statement.query_map([limit as i64], issue_from_row)?;
            let issues = rows.collect::<Result<Vec<_>, _>>()?.into_iter().collect::<IssueResult<Vec<_>>>()?;
            Ok((issues, total as usize))
        })
    }

    pub fn get(&self, id: &str) -> IssueResult<Issue> {
        self.read(|db| {
            issue_by_id(db, id)?.ok_or_else(|| IssueError::NotFound(format!("unknown issue {id}")))
        })
    }

    pub fn dismiss(&self, id: &str, reason: Option<String>) -> IssueResult<Issue> {
        let now = self.now();
        self.write(|tx| {
            let issue = issue_by_id(tx, id)?
                .ok_or_else(|| IssueError::NotFound(format!("unknown issue {id}")))?;
            if issue.status != IssueStatus::Open {
                return Err(IssueError::Conflict(format!(
                    "issue {id} is already {}",
                    issue.status.as_str()
                )));
            }
            tx.execute(
                "UPDATE issues SET status='dismissed', dismiss_reason=?1, updated_at=?2 WHERE id=?3 AND status='open'",
                params![reason, now, id],
            )?;
            issue_by_id(tx, id)?.ok_or_else(|| IssueError::Internal("dismiss vanished".into()))
        })
    }
}

fn constraint(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(err, _)
            if err.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

fn running_round(db: &Connection) -> IssueResult<Option<Round>> {
    db.query_row(
        "SELECT id, trigger_kind, status, members, started_at, finished_at, error, issue_count
         FROM rounds WHERE status='running' LIMIT 1",
        [],
        round_from_row,
    )
    .optional()?
    .transpose()
}

fn round_by_id(db: &Connection, id: &str) -> IssueResult<Option<Round>> {
    db.query_row(
        "SELECT id, trigger_kind, status, members, started_at, finished_at, error, issue_count
         FROM rounds WHERE id=?1",
        [id],
        round_from_row,
    )
    .optional()?
    .transpose()
}

fn round_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<IssueResult<Round>> {
    let members: String = row.get(3)?;
    let trigger: String = row.get(1)?;
    let status: String = row.get(2)?;
    Ok(parse_round(
        row.get(0)?,
        trigger,
        status,
        members,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
    ))
}

fn parse_round(
    id: String,
    trigger: String,
    status: String,
    members: String,
    started_at: i64,
    finished_at: Option<i64>,
    error: Option<String>,
    issue_count: i64,
) -> IssueResult<Round> {
    Ok(Round {
        id,
        trigger: Trigger::parse(&trigger)
            .ok_or_else(|| IssueError::Internal(format!("bad trigger {trigger}")))?,
        status: RoundStatus::parse(&status)
            .ok_or_else(|| IssueError::Internal(format!("bad round status {status}")))?,
        members: serde_json::from_str(&members)
            .map_err(|error| IssueError::Internal(format!("bad council members: {error}")))?,
        started_at,
        finished_at,
        error,
        issue_count: u32::try_from(issue_count).unwrap_or(u32::MAX),
    })
}

fn issue_by_id(db: &Connection, id: &str) -> IssueResult<Option<Issue>> {
    db.query_row(
        "SELECT id, kind, title, body, status, priority, proposed_by, round_id, dismiss_reason, created_at, updated_at
         FROM issues WHERE id=?1",
        [id],
        issue_from_row,
    )
    .optional()?
    .transpose()
}

fn open_by_key(db: &Connection, key: &str) -> IssueResult<Option<Issue>> {
    db.query_row(
        "SELECT id, kind, title, body, status, priority, proposed_by, round_id, dismiss_reason, created_at, updated_at
         FROM issues WHERE title_key=?1 AND status='open'",
        [key],
        issue_from_row,
    )
    .optional()?
    .transpose()
}

fn issue_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<IssueResult<Issue>> {
    let kind: String = row.get(1)?;
    let status: String = row.get(4)?;
    let priority: String = row.get(5)?;
    Ok(parse_issue(
        row.get(0)?,
        kind,
        row.get(2)?,
        row.get(3)?,
        status,
        priority,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        row.get(10)?,
    ))
}

fn parse_issue(
    id: String,
    kind: String,
    title: String,
    body: String,
    status: String,
    priority: String,
    proposed_by: String,
    round_id: String,
    dismiss_reason: Option<String>,
    created_at: i64,
    updated_at: i64,
) -> IssueResult<Issue> {
    Ok(Issue {
        id,
        kind: IssueKind::parse(&kind)
            .ok_or_else(|| IssueError::Internal(format!("bad issue kind {kind}")))?,
        title,
        body,
        status: IssueStatus::parse(&status)
            .ok_or_else(|| IssueError::Internal(format!("bad issue status {status}")))?,
        priority: Priority::parse(&priority)
            .ok_or_else(|| IssueError::Internal(format!("bad priority {priority}")))?,
        proposed_by,
        round_id,
        dismiss_reason,
        created_at,
        updated_at,
    })
}
