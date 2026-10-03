//! Durable operator jobs, measured runtime usage, and host verification evidence.
use anyhow::{bail, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ExecutionConfig {
    /// Measured token budgets; zero disables. Checked before each runtime prompt.
    pub task_token_limit: u64,
    pub project_token_limit: u64,
    /// Refuse further prompts after a runtime fails to report billing usage.
    pub require_usage: bool,
    pub checks: Vec<CheckConfig>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckConfig {
    pub name: String,
    /// Executable and arguments, without shell interpolation.
    pub command: Vec<String>,
    #[serde(default = "check_timeout")]
    pub timeout_secs: u64,
}
fn check_timeout() -> u64 {
    300
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}
impl Usage {
    pub fn total(&self) -> u64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_add(self.cache_read_tokens)
            .saturating_add(self.cache_write_tokens)
    }
    pub fn add(&mut self, other: &Self) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(other.cache_read_tokens);
        self.cache_write_tokens = self
            .cache_write_tokens
            .saturating_add(other.cache_write_tokens);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub turn_id: String,
    pub room_id: String,
    pub status: String,
    pub target: Value,
    pub message: String,
    pub result: Option<Value>,
    /// `user` for anything a client submitted, `host` for text Hivemind itself
    /// authored (a self-scheduled chat wakeup). Host-authored turns still reach
    /// the room as a user-style message, but they never authorize the
    /// directives reserved for genuine user input.
    pub origin: String,
}

/// A stored chat wakeup ready to be handed to the turn queue.
#[derive(Debug, Clone)]
pub struct ChatWakeupRow {
    pub id: String,
    pub room_id: String,
    pub target: Value,
    pub message: String,
    /// Idempotency key for the submitted turn: always present, unique per row.
    pub idem: String,
}

/// Result of storing a chat wakeup; `deduped` marks a repeated idempotency key.
#[derive(Debug, Clone)]
pub struct StoredChatWakeup {
    pub id: String,
    pub deduped: bool,
}

/// Per-conversation preferences that apply to every kind of room.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct RoomSettings {
    pub nickname: Option<String>,
    pub pinned: bool,
    pub muted: bool,
    /// Group follow-up budget: `None` follows the global default, `-1` is unlimited.
    pub follow_up_limit: Option<i64>,
}

/// A partial change to [`RoomSettings`]; `None` leaves a field alone and an empty
/// nickname clears it.
#[derive(Debug, Clone, Default)]
pub struct RoomSettingsPatch {
    pub nickname: Option<String>,
    pub pinned: Option<bool>,
    pub muted: Option<bool>,
    /// `Some(None)` returns the room to the global default.
    pub follow_up_limit: Option<Option<i64>>,
}

/// Largest finite follow-up budget a room may set (`-1` stores unlimited).
pub const MAX_FOLLOW_UP_LIMIT: i64 = 64;

pub struct ExecutionStore {
    db: Mutex<Connection>,
    pub config: ExecutionConfig,
    private_env: Mutex<Vec<String>>,
}
/// Current wall-clock time in whole seconds since the Unix epoch.
pub(crate) fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn job(row: &rusqlite::Row<'_>) -> rusqlite::Result<Job> {
    let target: String = row.get(3)?;
    let result: Option<String> = row.get(5)?;
    Ok(Job {
        turn_id: row.get(0)?,
        room_id: row.get(1)?,
        status: row.get(2)?,
        target: serde_json::from_str(&target).unwrap_or(Value::Null),
        message: row.get(4)?,
        result: result.and_then(|s| serde_json::from_str(&s).ok()),
        origin: row.get(6)?,
    })
}
const JOB_COLUMNS: &str = "turn_id,room_id,status,target,message,result,origin";
/// Turn origin for text the user (or an API client) submitted.
pub const ORIGIN_USER: &str = "user";
/// Turn origin for text Hivemind authored on the agent's behalf.
pub const ORIGIN_HOST: &str = "host";
impl ExecutionStore {
    pub fn open(path: impl AsRef<Path>, config: ExecutionConfig) -> Result<Self> {
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS jobs(turn_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, status TEXT NOT NULL, target TEXT NOT NULL, message TEXT NOT NULL, result TEXT, idem TEXT UNIQUE, created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status,created_at);
            CREATE TABLE IF NOT EXISTS bindings(room TEXT PRIMARY KEY, scope TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS projects(room TEXT PRIMARY KEY, project TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY, scope TEXT NOT NULL, project TEXT NOT NULL, turn_id TEXT NOT NULL, persona TEXT NOT NULL, epoch TEXT NOT NULL, usage TEXT, tokens INTEGER, created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS usage_scope ON usage(scope);
            CREATE INDEX IF NOT EXISTS usage_project ON usage(project);
            CREATE TABLE IF NOT EXISTS room_settings(room TEXT PRIMARY KEY, nickname TEXT, pinned INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS checks(id INTEGER PRIMARY KEY, task TEXT NOT NULL, commit_sha TEXT NOT NULL, name TEXT NOT NULL, result TEXT NOT NULL, passed INTEGER NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS chat_wakeups(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, target TEXT NOT NULL, message TEXT NOT NULL, due_at INTEGER NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, idem TEXT UNIQUE, created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS chat_wakeups_due ON chat_wakeups(state,due_at);
            CREATE INDEX IF NOT EXISTS chat_wakeups_room ON chat_wakeups(room_id,state);")?;
        if !db
            .prepare("SELECT 1 FROM pragma_table_info('jobs') WHERE name='origin'")?
            .exists([])?
        {
            db.execute_batch(&format!(
                "ALTER TABLE jobs ADD COLUMN origin TEXT NOT NULL DEFAULT '{ORIGIN_USER}';"
            ))?;
        }
        if !db
            .prepare(
                "SELECT 1 FROM pragma_table_info('room_settings') WHERE name='follow_up_limit'",
            )?
            .exists([])?
        {
            db.execute_batch("ALTER TABLE room_settings ADD COLUMN follow_up_limit INTEGER;")?;
        }
        for check in &config.checks {
            anyhow::ensure!(
                !check.name.trim().is_empty()
                    && !check.command.is_empty()
                    && !check.command[0].trim().is_empty()
                    && check.timeout_secs > 0,
                "verification checks need a name, executable, and positive timeout"
            );
        }
        let names: std::collections::HashSet<_> = config.checks.iter().map(|c| &c.name).collect();
        anyhow::ensure!(
            names.len() == config.checks.len(),
            "duplicate verification check name"
        );
        Ok(Self {
            db: Mutex::new(db),
            config,
            private_env: Mutex::new(Vec::new()),
        })
    }
    pub fn room_settings(&self, room: &str) -> Result<RoomSettings> {
        Ok(self
            .db
            .lock()
            .query_row(
                "SELECT nickname,pinned,muted,follow_up_limit FROM room_settings WHERE room=?",
                [room],
                |row| {
                    Ok(RoomSettings {
                        nickname: row.get(0)?,
                        pinned: row.get::<_, i64>(1)? != 0,
                        muted: row.get::<_, i64>(2)? != 0,
                        follow_up_limit: row.get(3)?,
                    })
                },
            )
            .optional()?
            .unwrap_or_default())
    }
    pub fn all_room_settings(&self) -> Result<Vec<(String, RoomSettings)>> {
        let db = self.db.lock();
        let mut statement =
            db.prepare("SELECT room,nickname,pinned,muted,follow_up_limit FROM room_settings")?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    RoomSettings {
                        nickname: row.get(1)?,
                        pinned: row.get::<_, i64>(2)? != 0,
                        muted: row.get::<_, i64>(3)? != 0,
                        follow_up_limit: row.get(4)?,
                    },
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
    pub fn update_room_settings(
        &self,
        room: &str,
        patch: &RoomSettingsPatch,
    ) -> Result<RoomSettings> {
        let mut next = self.room_settings(room)?;
        if let Some(nickname) = &patch.nickname {
            let nickname = nickname.trim();
            anyhow::ensure!(
                nickname.chars().count() <= 60 && !nickname.chars().any(char::is_control),
                "nickname must be at most 60 characters with no control characters"
            );
            next.nickname = (!nickname.is_empty()).then(|| nickname.to_owned());
        }
        if let Some(pinned) = patch.pinned {
            next.pinned = pinned;
        }
        if let Some(muted) = patch.muted {
            next.muted = muted;
        }
        if let Some(limit) = patch.follow_up_limit {
            anyhow::ensure!(
                limit.is_none_or(|n| (-1..=MAX_FOLLOW_UP_LIMIT).contains(&n)),
                "follow-up limit must be between 0 and {MAX_FOLLOW_UP_LIMIT}, or unlimited"
            );
            next.follow_up_limit = limit;
        }
        self.db.lock().execute(
            "INSERT INTO room_settings(room,nickname,pinned,muted,follow_up_limit,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(room) DO UPDATE SET nickname=excluded.nickname,pinned=excluded.pinned,muted=excluded.muted,follow_up_limit=excluded.follow_up_limit,updated_at=excluded.updated_at",
            params![room, next.nickname, next.pinned as i64, next.muted as i64, next.follow_up_limit, now()],
        )?;
        Ok(next)
    }
    pub fn protect_env(&self, name: Option<&str>) {
        if let Some(name) = name {
            self.private_env.lock().push(name.into());
        }
    }
    pub fn submit(
        &self,
        room: &str,
        target: &Value,
        message: &str,
        key: Option<&str>,
        origin: &str,
    ) -> Result<Job> {
        anyhow::ensure!(
            !message.trim().is_empty() && message.len() <= 1024 * 1024,
            "message must contain 1..1048576 bytes"
        );
        anyhow::ensure!(
            origin == ORIGIN_USER || origin == ORIGIN_HOST,
            "invalid turn origin"
        );
        if let Some(key) = key {
            anyhow::ensure!(
                !key.trim().is_empty() && key.len() <= 200,
                "invalid idempotency key"
            );
        }
        let mut db = self.db.lock();
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(key) = key {
            if let Some(existing) = tx
                .query_row(
                    &format!("SELECT {JOB_COLUMNS} FROM jobs WHERE idem=?"),
                    [key],
                    job,
                )
                .optional()?
            {
                anyhow::ensure!(
                    existing.room_id == room
                        && existing.target == *target
                        && existing.message == message,
                    "idempotency key already used for another request"
                );
                return Ok(existing);
            }
        }
        let id = crate::coordination::model::new_id("turn");
        tx.execute("INSERT INTO jobs(turn_id,room_id,status,target,message,idem,origin,created_at) VALUES(?,?,'queued',?,?,?,?,?)", params![id,room,target.to_string(),message,key,origin,now()])?;
        tx.commit()?;
        Ok(Job {
            turn_id: id,
            room_id: room.into(),
            status: "queued".into(),
            target: target.clone(),
            message: message.into(),
            result: None,
            origin: origin.into(),
        })
    }
    pub fn get(&self, id: &str) -> Result<Option<Job>> {
        Ok(self
            .db
            .lock()
            .query_row(
                &format!("SELECT {JOB_COLUMNS} FROM jobs WHERE turn_id=?"),
                [id],
                job,
            )
            .optional()?)
    }
    pub fn recover_jobs(&self) -> Result<()> {
        self.db.lock().execute(
            "UPDATE jobs SET status='interrupted' WHERE status='running'",
            [],
        )?;
        Ok(())
    }
    /// Stores one self-scheduled chat wakeup, deduped by `key`. At most
    /// `cap` wakeups may be outstanding per room; an over-cap result is the
    /// existing row when `key` repeats, otherwise an error.
    #[allow(clippy::too_many_arguments)]
    pub fn insert_chat_wakeup(
        &self,
        id: &str,
        room: &str,
        target: &Value,
        message: &str,
        due_at: i64,
        cap: i64,
        key: Option<&str>,
    ) -> Result<StoredChatWakeup> {
        anyhow::ensure!(
            !message.trim().is_empty() && message.len() <= 1024 * 1024,
            "wakeup message must contain 1..1048576 bytes"
        );
        anyhow::ensure!(
            key.is_none_or(|k| !k.trim().is_empty() && k.len() <= 200),
            "invalid idempotency key"
        );
        let mut db = self.db.lock();
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(key) = key {
            if let Some(id) = tx
                .query_row("SELECT id FROM chat_wakeups WHERE idem=?", [key], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?
            {
                return Ok(StoredChatWakeup { id, deduped: true });
            }
        }
        // The cap bounds outstanding *pending* (not-yet-due) wakeups. An
        // already-due row is not pending, so it is never blocked by the cap.
        if due_at > now() {
            let pending: i64 = tx.query_row(
                "SELECT COUNT(*) FROM chat_wakeups WHERE room_id=? AND state='queued' AND due_at>?",
                params![room, now()],
                |r| r.get(0),
            )?;
            anyhow::ensure!(pending < cap, "at most {cap} pending chat wakeups per room");
        }
        tx.execute("INSERT INTO chat_wakeups(id,room_id,target,message,due_at,state,idem,created_at) VALUES(?,?,?,?,?,'queued',?,?)", params![id, room, target.to_string(), message, due_at, key, now()])?;
        tx.commit()?;
        Ok(StoredChatWakeup {
            id: id.into(),
            deduped: false,
        })
    }
    /// Outstanding chat wakeups for `room` that are still queued and not yet
    /// due. `persona` further limits the count to wakeups addressed to it, so
    /// one person cannot exhaust a shared room's schedule budget.
    pub fn pending_chat_wakeups(&self, room: &str, persona: Option<&str>) -> Result<i64> {
        let db = self.db.lock();
        let mut statement = db.prepare(
            "SELECT target FROM chat_wakeups WHERE room_id=? AND state='queued' AND due_at>?",
        )?;
        let targets = statement
            .query_map(params![room, now()], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(match persona {
            None => targets.len() as i64,
            Some(persona) => targets
                .iter()
                .filter(|target| {
                    serde_json::from_str::<Value>(target)
                        .ok()
                        .is_some_and(|v| v.get("id").and_then(Value::as_str) == Some(persona))
                })
                .count() as i64,
        })
    }
    /// Chat wakeups that have come due, oldest first.
    pub fn due_chat_wakeups(&self, limit: usize) -> Result<Vec<ChatWakeupRow>> {
        let db = self.db.lock();
        let mut statement = db.prepare(
            "SELECT id,room_id,target,message,COALESCE(idem,id) FROM chat_wakeups WHERE state='queued' AND due_at<=? ORDER BY due_at,rowid LIMIT ?",
        )?;
        let rows = statement
            .query_map(params![now(), limit as i64], |r| {
                let target: String = r.get(2)?;
                Ok(ChatWakeupRow {
                    id: r.get(0)?,
                    room_id: r.get(1)?,
                    target: serde_json::from_str(&target).unwrap_or(Value::Null),
                    message: r.get(3)?,
                    idem: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
    /// Moves a chat wakeup to `state` if it is still queued or dispatched,
    /// counting one delivery attempt when it is handed to the turn queue.
    pub fn mark_chat_wakeup(&self, id: &str, state: &str) -> Result<()> {
        self.db.lock().execute(
            "UPDATE chat_wakeups SET state=?, attempts=attempts+(?='dispatched') WHERE id=? AND state IN ('queued','dispatched')",
            params![state, state, id],
        )?;
        Ok(())
    }
    /// Requeues chat wakeups left `dispatched` by a crash before their turn
    /// completed. Each handover counts as an attempt; once `max_attempts` is
    /// reached the wakeup is dropped rather than replayed forever.
    pub fn recover_chat_wakeups(&self, max_attempts: i64) -> Result<()> {
        let db = self.db.lock();
        db.execute(
            "UPDATE chat_wakeups SET state='queued' WHERE state='dispatched' AND attempts<?",
            [max_attempts],
        )?;
        db.execute(
            "UPDATE chat_wakeups SET state='failed' WHERE state='dispatched'",
            [],
        )?;
        Ok(())
    }
    pub fn claim(&self) -> Result<Option<Job>> {
        let mut db = self.db.lock();
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Jobs in one room run strictly in submission order, one at a time; other
        // rooms are independent, so a busy room never holds back an idle one.
        let next = tx.query_row(&format!("SELECT {JOB_COLUMNS} FROM jobs j WHERE j.status='queued' AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.room_id=j.room_id AND r.turn_id<>j.turn_id AND (r.status='running' OR (r.status='queued' AND (r.created_at,r.rowid)<(j.created_at,j.rowid)))) ORDER BY j.created_at,j.rowid LIMIT 1"), [], job).optional()?;
        if let Some(mut next) = next {
            tx.execute(
                "UPDATE jobs SET status='running' WHERE turn_id=? AND status='queued'",
                [&next.turn_id],
            )?;
            tx.commit()?;
            next.status = "running".into();
            Ok(Some(next))
        } else {
            Ok(None)
        }
    }
    pub fn finish(&self, id: &str, status: &str, result: Value) -> Result<()> {
        self.db.lock().execute(
            "UPDATE jobs SET status=?,result=? WHERE turn_id=? AND status='running'",
            params![status, result.to_string(), id],
        )?;
        Ok(())
    }
    pub fn cancel(&self, id: &str) -> Result<bool> {
        Ok(self.db.lock().execute(
            "UPDATE jobs SET status='cancelled' WHERE turn_id=? AND status IN ('queued','running')",
            [id],
        )? > 0)
    }
    pub fn bind_project(&self, room: &str, project: &str) -> Result<()> {
        self.db.lock().execute("INSERT INTO projects(room,project) VALUES(?,?) ON CONFLICT(room) DO UPDATE SET project=excluded.project", params![room,project])?;
        Ok(())
    }
    fn project(db: &Connection, room: &str, fallback: &str) -> Result<String> {
        Ok(db
            .query_row("SELECT project FROM projects WHERE room=?", [room], |r| {
                r.get(0)
            })
            .optional()?
            .unwrap_or_else(|| fallback.into()))
    }
    pub fn bind(&self, room: &str, root: &str) -> Result<()> {
        self.db.lock().execute("INSERT INTO bindings(room,scope) VALUES(?,?) ON CONFLICT(room) DO UPDATE SET scope=excluded.scope", params![room,root])?;
        Ok(())
    }
    fn scope(db: &Connection, room: &str) -> Result<String> {
        Ok(db
            .query_row("SELECT scope FROM bindings WHERE room=?", [room], |r| {
                r.get(0)
            })
            .optional()?
            .unwrap_or_else(|| room.into()))
    }
    pub fn check_budget(&self, room: &str, project: &str) -> Result<()> {
        let db = self.db.lock();
        let scope = Self::scope(&db, room)?;
        let project = Self::project(&db, room, project)?;
        for (column, value, limit) in [
            ("scope", scope.as_str(), self.config.task_token_limit),
            ("project", project.as_str(), self.config.project_token_limit),
        ] {
            let (tokens, unknown): (i64,i64) = db.query_row(&format!("SELECT COALESCE(SUM(tokens),0),COALESCE(SUM(tokens IS NULL),0) FROM usage WHERE {column}=?"), [value], |r| Ok((r.get(0)?,r.get(1)?)))?;
            if self.config.require_usage && unknown > 0 {
                bail!("usage unavailable; operator action required");
            }
            if limit > 0 && tokens as u64 >= limit {
                bail!("measured token budget exhausted");
            }
        }
        Ok(())
    }
    pub fn record_usage(
        &self,
        room: &str,
        project: &str,
        turn: &str,
        persona: &str,
        epoch: &str,
        usage: Option<&Usage>,
    ) -> Result<()> {
        let db = self.db.lock();
        let scope = Self::scope(&db, room)?;
        let project = Self::project(&db, room, project)?;
        db.execute("INSERT INTO usage(scope,project,turn_id,persona,epoch,usage,tokens,created_at) VALUES(?,?,?,?,?,?,?,?)", params![scope,project,turn,persona,epoch,usage.map(|u| serde_json::to_string(u).unwrap()),usage.map(|u| u.total().min(i64::MAX as u64) as i64),now()])?;
        Ok(())
    }
    pub fn usage(&self, scope: Option<&str>) -> Result<Value> {
        let db = self.db.lock();
        let mut statement = db.prepare("SELECT scope,project,turn_id,persona,epoch,usage FROM usage WHERE (?1 IS NULL OR scope=?1) ORDER BY id DESC LIMIT 200")?;
        let rows = statement.query_map([scope], |r| {
            let usage: Option<String> = r.get(5)?;
            Ok(json!({"scope":r.get::<_,String>(0)?,"project":r.get::<_,String>(1)?,"turn_id":r.get::<_,String>(2)?,"persona":r.get::<_,String>(3)?,"epoch":r.get::<_,String>(4)?,"usage":usage.and_then(|s|serde_json::from_str::<Value>(&s).ok())}))
        })?.collect::<rusqlite::Result<Vec<_>>>()?;
        let (tokens,unknown): (i64,i64) = db.query_row("SELECT COALESCE(SUM(tokens),0),COALESCE(SUM(tokens IS NULL),0) FROM usage WHERE (?1 IS NULL OR scope=?1)", [scope], |r| Ok((r.get(0)?,r.get(1)?)))?;
        Ok(json!({"measured_tokens":tokens,"unknown_prompts":unknown,"records":rows}))
    }
    pub fn record_check(
        &self,
        task: &str,
        sha: &str,
        name: &str,
        result: &Value,
        passed: bool,
    ) -> Result<()> {
        self.db.lock().execute(
            "INSERT INTO checks(task,commit_sha,name,result,passed,created_at) VALUES(?,?,?,?,?,?)",
            params![task, sha, name, result.to_string(), passed, now()],
        )?;
        Ok(())
    }
    pub fn checks(&self, task: &str) -> Result<Vec<Value>> {
        let db = self.db.lock();
        let mut stmt =
            db.prepare("SELECT result FROM checks WHERE task=? ORDER BY id DESC LIMIT 200")?;
        let records = stmt
            .query_map([task], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(records
            .into_iter()
            .filter_map(|s| serde_json::from_str(&s).ok())
            .collect())
    }
    pub fn verified(&self, task: &str, sha: &str) -> Result<bool> {
        let db = self.db.lock();
        for check in &self.config.checks {
            if db.query_row("SELECT passed FROM checks WHERE task=? AND commit_sha=? AND name=? ORDER BY id DESC LIMIT 1", params![task,sha,check.name], |r| r.get::<_,bool>(0)).optional()? != Some(true) { return Ok(false); }
        }
        Ok(true)
    }
}

/// A bounded command result, created by the host against the exact submitted checkout.
pub async fn verify(store: Arc<ExecutionStore>, task: &str, sha: &str, cwd: &Path) -> Result<bool> {
    use tokio::{io::AsyncReadExt, process::Command};
    let mut all = true;
    for check in &store.config.checks {
        let mut command = Command::new(&check.command[0]);
        command
            .args(&check.command[1..])
            .current_dir(cwd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        for name in store.private_env.lock().iter() {
            command.env_remove(name);
        }
        // Each check is its own process group; timeout also stops spawned test processes.
        #[cfg(unix)]
        command.process_group(0);
        let started = std::time::Instant::now();
        let result = match command.spawn() {
            Ok(mut child) => {
                let pid = child.id();
                let _group = ProcessGroup(pid);
                async fn drain(mut pipe: impl tokio::io::AsyncRead + Unpin) -> String {
                    let mut saved = Vec::new();
                    let mut chunk = [0u8; 4096];
                    while let Ok(n) = pipe.read(&mut chunk).await {
                        if n == 0 {
                            break;
                        }
                        let take = n.min(65536usize.saturating_sub(saved.len()));
                        saved.extend_from_slice(&chunk[..take]);
                    }
                    String::from_utf8_lossy(&saved).into_owned()
                }
                let stdout = tokio::spawn(drain(child.stdout.take().unwrap()));
                let stderr = tokio::spawn(drain(child.stderr.take().unwrap()));
                let status =
                    tokio::time::timeout(Duration::from_secs(check.timeout_secs), child.wait())
                        .await;
                let (passed, code, timed_out) = match status {
                    Ok(Ok(exit)) => (exit.success(), exit.code(), false),
                    _ => {
                        #[cfg(unix)]
                        if let Some(pid) = pid {
                            let _ = std::process::Command::new("kill")
                                .args(["-KILL", "--", &format!("-{pid}")])
                                .status();
                        }
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                        (false, None, true)
                    }
                };
                let out = tokio::time::timeout(Duration::from_secs(2), async {
                    (
                        stdout.await.unwrap_or_default(),
                        stderr.await.unwrap_or_default(),
                    )
                })
                .await
                .unwrap_or_default();
                json!({"passed":passed,"exit_code":code,"timed_out":timed_out,"stdout":out.0,"stderr":out.1})
            }
            Err(_) => json!({"passed":false,"error":"could not start configured check"}),
        };
        let mut result = result;
        result["name"] = json!(check.name);
        result["command"] = json!(check.command);
        result["commit_sha"] = json!(sha);
        result["elapsed_ms"] = json!(started.elapsed().as_millis() as u64);
        let passed = result["passed"] == true;
        store.record_check(task, sha, &check.name, &result, passed)?;
        all &= passed;
    }
    Ok(all)
}

/// Exclusive worker ownership across `serve` and `task run`. OS releases this
/// lock on a crash, so recovery needs no stale-lock guessing.
pub fn worker_lock(data_dir: &Path) -> Result<std::fs::File> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(data_dir.join("worker.lock"))?;
    file.try_lock()
        .map_err(|_| anyhow::anyhow!("another Hivemind worker already owns this data directory"))?;
    Ok(file)
}

/// Kills the process group when an invocation is dropped, including test children.
pub(crate) struct ProcessGroup(pub Option<u32>);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0 {
            let _ = std::process::Command::new("/bin/kill")
                .args(["-KILL", "--", &format!("-{pid}")])
                .stderr(std::process::Stdio::null())
                .status();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Directory(std::path::PathBuf);
    impl Directory {
        fn new() -> Self {
            let p = std::env::temp_dir().join(crate::coordination::model::new_id("execution-test"));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn submissions_are_durable_idempotent_and_recovery_never_replays_running_work() {
        let directory = Directory::new();
        let path = directory.0.join("execution.sqlite3");
        let db = ExecutionStore::open(&path, Default::default()).unwrap();
        let target = json!({"type":"main"});
        let a = db
            .submit("main", &target, "hello", Some("key"), ORIGIN_USER)
            .unwrap();
        let b = db
            .submit("main", &target, "hello", Some("key"), ORIGIN_USER)
            .unwrap();
        assert_eq!(a.turn_id, b.turn_id);
        assert!(db
            .submit("main", &target, "different", Some("key"), ORIGIN_USER)
            .is_err());
        let queued = db
            .submit("main", &target, "later", None, ORIGIN_USER)
            .unwrap();
        assert_eq!(db.claim().unwrap().unwrap().turn_id, a.turn_id);
        drop(db);
        let db = ExecutionStore::open(&path, Default::default()).unwrap();
        db.recover_jobs().unwrap();
        assert_eq!(db.get(&a.turn_id).unwrap().unwrap().status, "interrupted");
        assert_eq!(db.claim().unwrap().unwrap().turn_id, queued.turn_id);
        assert!(db.claim().unwrap().is_none());
    }
    #[test]
    fn rooms_claim_independently_but_stay_ordered_within_a_room() {
        let db = ExecutionStore::open(":memory:", Default::default()).unwrap();
        let target = json!({"type":"main"});
        let a1 = db.submit("a", &target, "a1", None, ORIGIN_USER).unwrap();
        let a2 = db.submit("a", &target, "a2", None, ORIGIN_USER).unwrap();
        let b1 = db.submit("b", &target, "b1", None, ORIGIN_USER).unwrap();
        assert_eq!(db.claim().unwrap().unwrap().turn_id, a1.turn_id);
        // Room a is busy, so a2 waits while room b starts immediately.
        assert_eq!(db.claim().unwrap().unwrap().turn_id, b1.turn_id);
        assert!(db.claim().unwrap().is_none());
        db.finish(&a1.turn_id, "completed", json!({})).unwrap();
        assert_eq!(db.claim().unwrap().unwrap().turn_id, a2.turn_id);
    }
    #[test]
    fn room_settings_default_off_persist_and_validate() {
        let db = ExecutionStore::open(":memory:", Default::default()).unwrap();
        assert_eq!(db.room_settings("main").unwrap(), RoomSettings::default());
        let saved = db
            .update_room_settings(
                "main",
                &RoomSettingsPatch {
                    nickname: Some("  Town hall ".into()),
                    pinned: Some(true),
                    muted: None,
                    follow_up_limit: None,
                },
            )
            .unwrap();
        assert_eq!(saved.nickname.as_deref(), Some("Town hall"));
        assert!(saved.pinned && !saved.muted);
        // A partial patch keeps everything it does not mention.
        let saved = db
            .update_room_settings(
                "main",
                &RoomSettingsPatch {
                    muted: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(saved.nickname.as_deref(), Some("Town hall"));
        assert!(saved.pinned && saved.muted);
        // An empty nickname clears it; rooms are independent.
        let cleared = db
            .update_room_settings(
                "main",
                &RoomSettingsPatch {
                    nickname: Some(String::new()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(cleared.nickname, None);
        assert_eq!(
            db.room_settings("group-a").unwrap(),
            RoomSettings::default()
        );
        assert!(db
            .update_room_settings(
                "main",
                &RoomSettingsPatch {
                    nickname: Some("x".repeat(61)),
                    ..Default::default()
                },
            )
            .is_err());
        assert_eq!(db.all_room_settings().unwrap().len(), 1);
        // The follow-up budget: default, finite, unlimited (-1), reset, and bounds.
        let set = |limit| {
            db.update_room_settings(
                "group-a",
                &RoomSettingsPatch {
                    follow_up_limit: Some(limit),
                    ..Default::default()
                },
            )
        };
        assert_eq!(set(Some(5)).unwrap().follow_up_limit, Some(5));
        assert_eq!(set(Some(-1)).unwrap().follow_up_limit, Some(-1));
        assert_eq!(
            db.room_settings("group-a").unwrap().follow_up_limit,
            Some(-1)
        );
        assert_eq!(set(None).unwrap().follow_up_limit, None);
        assert!(set(Some(MAX_FOLLOW_UP_LIMIT + 1)).is_err());
        assert!(set(Some(-2)).is_err());
    }
    #[test]
    fn cancellation_wins_over_late_completion() {
        let db = ExecutionStore::open(":memory:", Default::default()).unwrap();
        let j = db
            .submit("main", &json!({"type":"main"}), "hi", None, ORIGIN_USER)
            .unwrap();
        db.claim().unwrap();
        assert!(db.cancel(&j.turn_id).unwrap());
        db.finish(&j.turn_id, "completed", json!({"reply":"late"}))
            .unwrap();
        assert_eq!(db.get(&j.turn_id).unwrap().unwrap().status, "cancelled");
        assert!(!db.cancel(&j.turn_id).unwrap());
    }
    #[test]
    fn concurrent_claims_do_not_run_a_job_twice() {
        let directory = Directory::new();
        let path = directory.0.join("store");
        let db = ExecutionStore::open(&path, Default::default()).unwrap();
        db.submit("main", &json!({"type":"main"}), "hi", None, ORIGIN_USER)
            .unwrap();
        let other = ExecutionStore::open(&path, Default::default()).unwrap();
        let first = std::thread::spawn(move || db.claim().unwrap().is_some());
        let second = std::thread::spawn(move || other.claim().unwrap().is_some());
        assert_ne!(first.join().unwrap(), second.join().unwrap());
    }
    #[test]
    fn usage_charges_the_root_and_original_project_and_blocks_future_admission() {
        let db = ExecutionStore::open(
            ":memory:",
            ExecutionConfig {
                task_token_limit: 10,
                project_token_limit: 15,
                ..Default::default()
            },
        )
        .unwrap();
        db.bind("task-child", "root").unwrap();
        db.bind_project("task-child", "/repo").unwrap();
        db.record_usage(
            "task-child",
            "/temporary/worktree",
            "t",
            "P",
            "e",
            Some(&Usage {
                input_tokens: 7,
                output_tokens: 3,
                ..Default::default()
            }),
        )
        .unwrap();
        assert!(db
            .check_budget("task-child", "/different-worktree")
            .is_err());
        assert!(db.check_budget("another-root", "/repo").is_ok());
        db.record_usage(
            "another-root",
            "/repo",
            "t2",
            "P",
            "e",
            Some(&Usage {
                input_tokens: 5,
                ..Default::default()
            }),
        )
        .unwrap();
        assert!(db.check_budget("third-root", "/repo").is_err());
        assert_eq!(db.usage(Some("root")).unwrap()["measured_tokens"], 10);
    }
    #[test]
    fn unavailable_usage_is_null_and_fail_closed_when_required() {
        let db = ExecutionStore::open(
            ":memory:",
            ExecutionConfig {
                require_usage: true,
                ..Default::default()
            },
        )
        .unwrap();
        db.record_usage("r", "p", "t", "a", "e", None).unwrap();
        let report = db.usage(Some("r")).unwrap();
        assert_eq!(report["unknown_prompts"], 1);
        assert!(report["records"][0]["usage"].is_null());
        assert!(db.check_budget("r", "p").is_err());
    }
    #[tokio::test]
    async fn host_checks_bind_to_exact_commit_and_record_failures_and_bounded_logs() {
        let directory = Directory::new();
        let config = ExecutionConfig {
            checks: vec![CheckConfig {
                name: "test".into(),
                command: vec![
                    "sh".into(),
                    "-c".into(),
                    "printf checked; test -f pass".into(),
                ],
                timeout_secs: 2,
            }],
            ..Default::default()
        };
        let db = Arc::new(ExecutionStore::open(":memory:", config).unwrap());
        assert!(!verify(db.clone(), "task", "sha1", &directory.0)
            .await
            .unwrap());
        assert!(!db.verified("task", "sha1").unwrap());
        std::fs::write(directory.0.join("pass"), "").unwrap();
        assert!(verify(db.clone(), "task", "sha1", &directory.0)
            .await
            .unwrap());
        assert!(db.verified("task", "sha1").unwrap());
        assert!(!db.verified("task", "sha2").unwrap());
        let report = db.checks("task").unwrap();
        assert_eq!(report[0]["stdout"], "checked");
        assert_eq!(report[1]["exit_code"], 1);
    }
    #[tokio::test]
    async fn timed_out_check_cannot_pass() {
        let directory = Directory::new();
        let config = ExecutionConfig {
            checks: vec![CheckConfig {
                name: "hang".into(),
                command: vec!["sleep".into(), "5".into()],
                timeout_secs: 1,
            }],
            ..Default::default()
        };
        let db = Arc::new(ExecutionStore::open(":memory:", config).unwrap());
        assert!(!verify(db.clone(), "task", "sha", &directory.0)
            .await
            .unwrap());
        assert_eq!(db.checks("task").unwrap()[0]["timed_out"], true);
    }
    #[test]
    fn worker_lock_releases_on_drop_and_excludes_a_second_worker() {
        let directory = Directory::new();
        let lock = worker_lock(&directory.0).unwrap();
        assert!(worker_lock(&directory.0).is_err());
        drop(lock);
        assert!(worker_lock(&directory.0).is_ok());
    }
    fn wakeup(
        db: &ExecutionStore,
        id: &str,
        room: &str,
        target: &Value,
        message: &str,
        due_at: i64,
        key: Option<&str>,
    ) -> Result<StoredChatWakeup> {
        db.insert_chat_wakeup(
            id,
            room,
            target,
            message,
            due_at,
            crate::wakeup::MAX_PENDING_CHAT_WAKEUPS,
            key,
        )
    }
    #[test]
    fn chat_wakeups_dedupe_bound_and_fire_only_when_due() {
        let db = ExecutionStore::open(":memory:", Default::default()).unwrap();
        let soon = json!({"type":"solo","id":"Lead"});
        let later = json!({"type":"solo","id":"Lead"});
        let now = now();
        // Dedupe: a repeated idempotency key returns the original row untouched.
        let stored = wakeup(
            &db,
            "wk_1",
            "solo-Lead",
            &soon,
            "Intent: a",
            now + 60,
            Some("k1"),
        )
        .unwrap();
        assert!(!stored.deduped);
        let again = wakeup(
            &db,
            "wk_other",
            "solo-Lead",
            &soon,
            "Intent: a",
            now + 60,
            Some("k1"),
        )
        .unwrap();
        assert!(again.deduped);
        assert_eq!(again.id, "wk_1");
        // Due-only selection: a future wakeup is neither due nor blocking re-claim.
        assert!(db.due_chat_wakeups(10).unwrap().is_empty());
        assert_eq!(db.pending_chat_wakeups("solo-Lead", None).unwrap(), 1);
        // The pending cap counts only queued, not-yet-due rows for this room.
        for n in 2..=crate::wakeup::MAX_PENDING_CHAT_WAKEUPS {
            wakeup(
                &db,
                &format!("wk_{n}"),
                "solo-Lead",
                &soon,
                "Intent: a",
                now + 60,
                None,
            )
            .unwrap();
        }
        assert!(wakeup(
            &db,
            "wk_cap",
            "solo-Lead",
            &soon,
            "Intent: a",
            now + 60,
            None
        )
        .is_err());
        assert_eq!(
            db.pending_chat_wakeups("solo-Lead", None).unwrap(),
            crate::wakeup::MAX_PENDING_CHAT_WAKEUPS
        );
        // A different room has its own budget; an already-due row is not "pending".
        wakeup(
            &db,
            "wk_due",
            "solo-Lead",
            &later,
            "Intent: b",
            now - 1,
            None,
        )
        .unwrap();
        assert_eq!(
            db.pending_chat_wakeups("solo-Lead", Some("Lead")).unwrap(),
            crate::wakeup::MAX_PENDING_CHAT_WAKEUPS
        );
        assert_eq!(
            db.pending_chat_wakeups("solo-Lead", Some("Other")).unwrap(),
            0
        );
        let due = db.due_chat_wakeups(10).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, "wk_due");
        assert_eq!(due[0].idem, "wk_due");
        assert_eq!(due[0].target, later);
        assert!(wakeup(
            &db,
            "wk_other",
            "solo-Other",
            &soon,
            "Intent: a",
            now + 60,
            None
        )
        .is_ok());
    }
    #[test]
    fn dispatched_chat_wakeups_are_redelivered_after_a_restart_within_a_bound() {
        let directory = Directory::new();
        let path = directory.0.join("wakeups.sqlite3");
        let db = ExecutionStore::open(&path, Default::default()).unwrap();
        let target = json!({"type":"main"});
        let now = now();
        wakeup(
            &db,
            "wk_1",
            "main",
            &target,
            "Intent: a",
            now - 1,
            Some("k1"),
        )
        .unwrap();
        assert_eq!(db.due_chat_wakeups(10).unwrap().len(), 1);
        db.mark_chat_wakeup("wk_1", "dispatched").unwrap();
        assert!(
            db.due_chat_wakeups(10).unwrap().is_empty(),
            "dispatched once"
        );
        drop(db);
        let db = ExecutionStore::open(&path, Default::default()).unwrap();
        // A restart requeues it, so the unsubmitted wakeup is not lost.
        db.recover_chat_wakeups(crate::wakeup::MAX_CHAT_WAKEUP_ATTEMPTS)
            .unwrap();
        assert_eq!(db.due_chat_wakeups(10).unwrap().len(), 1);
        for attempt in 2..crate::wakeup::MAX_CHAT_WAKEUP_ATTEMPTS {
            db.mark_chat_wakeup("wk_1", "dispatched").unwrap();
            db.recover_chat_wakeups(crate::wakeup::MAX_CHAT_WAKEUP_ATTEMPTS)
                .unwrap();
            let requeued = db.due_chat_wakeups(10).unwrap().len();
            assert_eq!(requeued, 1, "attempt {attempt} is still within the bound");
        }
        // Past the attempt bound it is dropped, never replayed forever.
        db.mark_chat_wakeup("wk_1", "dispatched").unwrap();
        db.recover_chat_wakeups(crate::wakeup::MAX_CHAT_WAKEUP_ATTEMPTS)
            .unwrap();
        assert!(db.due_chat_wakeups(10).unwrap().is_empty());
        assert_eq!(db.pending_chat_wakeups("main", None).unwrap(), 0);
    }
}
