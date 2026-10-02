//! Durable operator questions. Waiting is a deliberate turn boundary, not a retry:
//! the runner commits a checkpoint before another attempt can be claimed.
use super::{
    live::OpenQuestion,
    model::*,
    service::{CoordinationService, ToolCtx},
    store::Db,
};
use rusqlite::{params, OptionalExtension};

impl Db<'_> {
    pub fn deferred_for_attempt(&self, attempt: &str) -> CoordResult<bool> {
        Ok(self.c.query_row(
            "SELECT EXISTS(SELECT 1 FROM deferred_questions WHERE attempt_id=?)",
            [attempt],
            |r| r.get(0),
        )?)
    }
    pub fn activate_answer(&self, task: &str) -> CoordResult<()> {
        let answered: bool = self.c.query_row("SELECT COALESCE((SELECT status='answered' FROM deferred_questions WHERE task_id=? ORDER BY asked_at DESC,id DESC LIMIT 1),0)", [task], |r| r.get(0))?;
        let current = self.task_or_err(task)?;
        if answered
            && current.status == TaskStatus::NeedsInput
            && self.running_attempts(Some(task))?.is_empty()
        {
            let root = current.id == current.root_id;
            self.set_status(
                task,
                if root {
                    TaskStatus::Planning
                } else {
                    TaskStatus::Ready
                },
                None,
                "hivemind",
                None,
            )?;
        }
        Ok(())
    }
    pub fn checkpoint(&self, task: &str) -> CoordResult<Option<String>> {
        Ok(self
            .artifacts(task)?
            .into_iter()
            .rev()
            .find(|a| a.kind == "checkpoint")
            .and_then(|a| a.content_hash))
    }
}

impl CoordinationService {
    pub fn defer_question(&self, ctx: &ToolCtx, question: &str) -> CoordResult<String> {
        self.live(ctx)?;
        if !matches!(ctx.kind, AttemptKind::Work | AttemptKind::Plan) {
            return Err(CoordError::Forbidden(
                "only work and plan attempts can wait".into(),
            ));
        }
        let question = check_text("question", question, 2000)?;
        let id = new_id("q");
        if !self.open_questions(&ctx.task_id).is_empty() {
            return Err(CoordError::Conflict(
                "an open question already exists".into(),
            ));
        }
        self.store().write(|db| {
            let task = db.task_or_err(&ctx.task_id)?;
            let count: u32 = db.c.query_row("SELECT COUNT(*) FROM deferred_questions WHERE task_id=?", [&task.id], |r| r.get(0))?;
            if count >= self.config().max_questions { return Err(CoordError::Invalid("durable question limit reached for this task".into())); }
            db.c.execute("INSERT INTO deferred_questions(id,task_id,attempt_id,persona,question,asked_at,status) VALUES(?,?,?,?,?,?,'open')", params![id,task.id,ctx.attempt_id,ctx.persona,question,db.now])?;
            db.set_status(&task.id, TaskStatus::NeedsInput, Some(&question), &ctx.persona, None)?;
            db.event(&task.root_id, Some(&task.id), &ctx.persona, "task.question", serde_json::json!({"id":id,"question":question,"durable":true}))?;
            Ok(())
        })?;
        self.changed();
        Ok(id)
    }
    pub fn deferred_questions(&self, task: &str) -> CoordResult<Vec<OpenQuestion>> {
        self.store().read(|db| {
            Ok(db.c.prepare("SELECT q.attempt_id,q.persona,q.question,q.asked_at FROM deferred_questions q JOIN tasks t ON t.id=q.task_id JOIN tasks root ON root.id=t.root_id WHERE q.task_id=? AND q.status='open' AND t.status='needs_input' AND root.status NOT IN ('completed','failed','cancelled') ORDER BY q.asked_at")?.query_map([task], |r| Ok(OpenQuestion {attempt_id:r.get(0)?,persona:r.get(1)?,question:r.get(2)?,asked_at:r.get(3)?,to:None,message_id:None}))?.collect::<rusqlite::Result<_>>()?)
        })
    }
    pub fn answer_deferred(&self, task_id: &str, answer: &str, actor: &str) -> CoordResult<bool> {
        let answered = self.store().write(|db| {
            let question: Option<String> = db.c.query_row("SELECT id FROM deferred_questions WHERE task_id=? AND status='open'", [task_id], |r| r.get(0)).optional()?;
            let Some(id) = question else { return Ok(false) };
            let task = db.task_or_err(task_id)?;
            let root = db.task_or_err(&task.root_id)?;
            if task.status != TaskStatus::NeedsInput || root.status.is_terminal() { return Err(CoordError::Conflict("question is no longer answerable".into())); }
            db.c.execute("UPDATE deferred_questions SET status='answered',answer=?,answered_by=? WHERE id=?", params![answer,actor,id])?;
            db.push_feedback(task_id, &format!("Answer from {actor} to question {id}: {answer}. Continue from the checkpoint; do not repeat completed work or external side effects."))?;
            db.event(&task.root_id, Some(task_id), actor, "task.answered", serde_json::json!({"id":id,"answer":answer,"durable":true}))?;
            db.activate_answer(task_id)?;
            Ok(true)
        })?;
        if answered {
            self.changed();
        }
        Ok(answered)
    }
}
