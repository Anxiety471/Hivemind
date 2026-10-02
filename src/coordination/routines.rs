//! Durable recurring task templates. Schedule reservations and immutable run
//! snapshots commit before task submission; retries reuse a host idempotency key.
use super::{
    model::*,
    service::{CoordinationService, SubmitTask},
    store::Db,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoutineInput {
    pub name: String,
    pub objective: String,
    pub interval_secs: u64,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub workspace: Option<String>,
}

impl Db<'_> {
    fn routine_spec(&self, id: &str) -> CoordResult<(RoutineInput, bool, i64, i64)> {
        let row: Option<(String, bool, i64, i64)> = self
            .c
            .query_row(
                "SELECT spec,enabled,next_at,revision FROM routines WHERE id=?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let (spec, enabled, next, revision) =
            row.ok_or_else(|| CoordError::NotFound("routine not found".into()))?;
        Ok((
            serde_json::from_str(&spec)
                .map_err(|_| CoordError::Internal("invalid routine snapshot".into()))?,
            enabled,
            next,
            revision,
        ))
    }
    fn routine_run(&self, id: &str) -> CoordResult<Value> {
        Ok(self.c.query_row("SELECT id,routine_id,status,task_id,created_at,error FROM routine_runs WHERE id=?", [id], |r| Ok(json!({"id":r.get::<_,String>(0)?,"routine_id":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?,"task_id":r.get::<_,Option<String>>(3)?,"created_at":r.get::<_,i64>(4)?,"error":r.get::<_,Option<String>>(5)?})))?)
    }
}
impl CoordinationService {
    pub fn create_routine(&self, mut spec: RoutineInput) -> CoordResult<Value> {
        if !self.enabled() {
            return Err(CoordError::Disabled);
        }
        spec.name = check_text("name", &spec.name, 200)?;
        spec.objective = check_text("objective", &spec.objective, 8000)?;
        if !(60..=31_536_000).contains(&spec.interval_secs) {
            return Err(CoordError::Invalid(
                "interval_secs must be between 60 and 31536000".into(),
            ));
        }
        if spec.acceptance.len() > 12 || spec.capabilities.len() > 8 {
            return Err(CoordError::Invalid(
                "at most 12 criteria and 8 capabilities".into(),
            ));
        }
        for criterion in &spec.acceptance {
            check_text("criterion", criterion, 600)?;
        }
        for capability in &spec.capabilities {
            check_text("capability", capability, 100)?;
        }
        if let Some(workspace) = &spec.workspace {
            check_text("workspace", workspace, 1024)?;
        }
        let id = new_id("rt");
        self.store().write(|db| {
            db.c.execute(
                "INSERT INTO routines(id,spec,next_at) VALUES(?,?,?)",
                params![
                    id,
                    serde_json::to_string(&spec).unwrap(),
                    db.now + spec.interval_secs as i64
                ],
            )?;
            Ok(())
        })?;
        self.routine(&id)
    }
    pub fn routine(&self, id: &str) -> CoordResult<Value> {
        self.store().read(|db| {
            let (spec,enabled,next,revision) = db.routine_spec(id)?;
            let mut value = serde_json::to_value(spec).unwrap();
            value["id"] = json!(id); value["enabled"] = json!(enabled); value["next_at"] = json!(next); value["revision"] = json!(revision);
            let ids = db.c.prepare("SELECT id FROM routine_runs WHERE routine_id=? ORDER BY created_at DESC,id DESC LIMIT 20")?.query_map([id], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            value["runs"] = json!(ids.iter().map(|id| db.routine_run(id)).collect::<CoordResult<Vec<_>>>()?);
            Ok(value)
        })
    }
    pub fn routines(&self) -> CoordResult<Vec<Value>> {
        let ids = self.store().read(|db| {
            Ok(db
                .c
                .prepare("SELECT id FROM routines ORDER BY id")?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })?;
        ids.iter().map(|id| self.routine(id)).collect()
    }
    pub fn set_routine_enabled(
        &self,
        id: &str,
        enabled: bool,
        revision: i64,
    ) -> CoordResult<Value> {
        self.store().write(|db| {
            let (spec, _, next, current) = db.routine_spec(id)?;
            if current != revision {
                return Err(CoordError::Conflict(
                    "routine changed; reload before editing".into(),
                ));
            }
            // Resuming skips missed runs rather than flooding the scheduler.
            db.c.execute(
                "UPDATE routines SET enabled=?,next_at=?,revision=revision+1 WHERE id=?",
                params![
                    enabled,
                    if enabled {
                        db.now + spec.interval_secs as i64
                    } else {
                        next
                    },
                    id
                ],
            )?;
            Ok(())
        })?;
        self.routine(id)
    }
    pub fn run_routine(&self, id: &str, key: Option<&str>) -> CoordResult<Value> {
        let key = key
            .map(|k| check_text("idempotency key", k, 128))
            .transpose()?
            .unwrap_or_else(|| new_id("manual"));
        self.reserve_routine(id, &format!("manual:{key}"), None)
    }
    fn reserve_routine(&self, id: &str, key: &str, scheduled: Option<i64>) -> CoordResult<Value> {
        let run = self.store().write(|db| {
            if let Some(existing) = db.c.query_row("SELECT id FROM routine_runs WHERE routine_id=? AND trigger_key=?", params![id,key], |r| r.get::<_,String>(0)).optional()? { return Ok(existing); }
            let (spec,enabled,next,_) = db.routine_spec(id)?;
            if !enabled { return Err(CoordError::Conflict("routine is paused".into())); }
            if scheduled.is_some_and(|due| due != next || due > db.now) { return Err(CoordError::Conflict("routine schedule changed".into())); }
            let active: Option<Option<String>> = db.c.query_row("SELECT r.task_id FROM routine_runs r LEFT JOIN tasks t ON t.id=r.task_id WHERE r.routine_id=? AND (r.status='pending' OR (r.status='submitted' AND t.status NOT IN ('completed','failed','cancelled'))) ORDER BY r.created_at DESC LIMIT 1", [id], |r| r.get(0)).optional()?;
            let run = new_id("rr");
            db.c.execute("INSERT INTO routine_runs(id,routine_id,trigger_key,status,task_id,spec,created_at) VALUES(?,?,?,?,?,?,?)", params![run,id,key,if active.is_some() {"coalesced"} else {"pending"},active.flatten(),serde_json::to_string(&spec).unwrap(),db.now])?;
            if scheduled.is_some() { db.c.execute("UPDATE routines SET next_at=? WHERE id=?", params![db.now+spec.interval_secs as i64,id])?; }
            Ok(run)
        })?;
        self.submit_routine_run(&run)?;
        self.store().read(|db| db.routine_run(&run))
    }
    fn submit_routine_run(&self, id: &str) -> CoordResult<()> {
        let spec = self.store().read(|db| {
            Ok(db
                .c
                .query_row(
                    "SELECT spec FROM routine_runs WHERE id=? AND status='pending'",
                    [id],
                    |r| r.get::<_, String>(0),
                )
                .optional()?)
        })?;
        let Some(spec) = spec else { return Ok(()) };
        let spec: RoutineInput = serde_json::from_str(&spec)
            .map_err(|_| CoordError::Internal("invalid run snapshot".into()))?;
        let result = self.submit(SubmitTask {
            objective: spec.objective,
            acceptance: spec.acceptance,
            capabilities: spec.capabilities,
            workspace: spec.workspace,
            plan: None,
            idempotency_key: Some(format!("routine-run:{id}")),
        });
        self.store().write(|db| {
            match result {
                Ok(detail) => { db.c.execute("UPDATE routine_runs SET status='submitted',task_id=? WHERE id=? AND status='pending'", params![detail.task.id,id])?; }
                Err(error) => { let message = if matches!(error, CoordError::Internal(_)) {"task submission failed".into()} else {error.to_string()}; db.c.execute("UPDATE routine_runs SET status='failed',error=? WHERE id=?", params![message,id])?; }
            }
            Ok(())
        })
    }
    pub fn tick_routines(&self) -> CoordResult<()> {
        if !self.enabled() {
            return Ok(());
        }
        let due = self.store().read(|db| Ok(db.c.prepare("SELECT id,next_at FROM routines WHERE enabled=1 AND next_at<=? ORDER BY next_at LIMIT 20")?.query_map([db.now], |r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?))?;
        for (id, due) in due {
            self.reserve_routine(&id, &format!("schedule:{due}"), Some(due))?;
        }
        let pending = self.store().read(|db| Ok(db.c.prepare("SELECT id FROM routine_runs WHERE status='pending' ORDER BY created_at LIMIT 100")?.query_map([], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?))?;
        for id in pending {
            self.submit_routine_run(&id)?;
        }
        Ok(())
    }
}
