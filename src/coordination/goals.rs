//! Persistent project intent, inherited by every task under a linked root.
use super::{model::*, policy, service::CoordinationService, store::Db};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GoalInput {
    pub title: String,
    pub description: String,
    pub workspace: String,
    #[serde(default)]
    pub constraints: Vec<String>,
    pub success_criteria: Vec<String>,
}
#[derive(Debug, Clone, Serialize)]
pub struct Goal {
    pub id: String,
    #[serde(flatten)]
    pub definition: GoalInput,
    pub status: String,
    pub revision: i64,
}
impl Db<'_> {
    pub fn goal(&self, id: &str) -> CoordResult<Goal> {
        let value: Option<(String, String, i64)> = self
            .c
            .query_row(
                "SELECT definition,status,revision FROM project_goals WHERE id=?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let (definition, status, revision) =
            value.ok_or_else(|| CoordError::NotFound("goal not found".into()))?;
        Ok(Goal {
            id: id.into(),
            definition: serde_json::from_str(&definition)
                .map_err(|_| CoordError::Internal("invalid goal record".into()))?,
            status,
            revision,
        })
    }
    pub fn task_goal(&self, root: &str) -> CoordResult<Option<Goal>> {
        let id: Option<String> = self
            .c
            .query_row(
                "SELECT goal_id FROM task_goals WHERE root_id=?",
                [root],
                |r| r.get(0),
            )
            .optional()?;
        id.map(|id| self.goal(&id)).transpose()
    }
    pub fn link_goal(&self, root: &str, id: &str, workspace: &str) -> CoordResult<()> {
        let goal = self.goal(id)?;
        if goal.status != "active" {
            return Err(CoordError::Conflict(
                "only active goals accept new tasks".into(),
            ));
        }
        if goal.definition.workspace != workspace {
            return Err(CoordError::Invalid(
                "goal and task must use the same project workspace".into(),
            ));
        }
        self.c.execute(
            "INSERT INTO task_goals(root_id,goal_id) VALUES(?,?)",
            params![root, id],
        )?;
        Ok(())
    }
}
impl CoordinationService {
    pub fn create_goal(&self, mut input: GoalInput) -> CoordResult<Goal> {
        if !self.enabled() {
            return Err(CoordError::Disabled);
        }
        input.title = check_text("title", &input.title, 200)?;
        input.description = check_text("description", &input.description, 4000)?;
        input.workspace =
            policy::normalize_workspace(&check_text("workspace", &input.workspace, 1024)?);
        if !self
            .roster()
            .personas()
            .iter()
            .any(|p| policy::Roster::eligible_for_workspace(p, &input.workspace))
        {
            return Err(CoordError::Invalid(
                "goal workspace must belong to a configured persona".into(),
            ));
        }
        if input.success_criteria.is_empty()
            || input.success_criteria.len() > 12
            || input.constraints.len() > 12
        {
            return Err(CoordError::Invalid(
                "provide 1–12 success criteria and at most 12 constraints".into(),
            ));
        }
        for criterion in input
            .success_criteria
            .iter()
            .chain(input.constraints.iter())
        {
            check_text("goal criterion or constraint", criterion, 600)?;
        }
        let id = new_id("goal");
        self.store().write(|db| {
            db.c.execute(
                "INSERT INTO project_goals(id,definition) VALUES(?,?)",
                params![id, serde_json::to_string(&input).unwrap()],
            )?;
            db.goal(&id)
        })
    }
    pub fn goals(&self) -> CoordResult<Vec<Goal>> {
        self.store().read(|db| {
            let ids =
                db.c.prepare("SELECT id FROM project_goals ORDER BY id")?
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
            ids.iter().map(|id| db.goal(id)).collect()
        })
    }
    pub fn set_goal_status(&self, id: &str, status: &str, revision: i64) -> CoordResult<Goal> {
        if !matches!(status, "active" | "achieved" | "archived") {
            return Err(CoordError::Invalid(
                "status must be active, achieved, or archived".into(),
            ));
        }
        self.store().write(|db| {
            let goal = db.goal(id)?;
            if goal.revision != revision {
                return Err(CoordError::Conflict(
                    "goal changed; reload before editing".into(),
                ));
            }
            db.c.execute(
                "UPDATE project_goals SET status=?,revision=revision+1 WHERE id=?",
                params![status, id],
            )?;
            db.goal(id)
        })
    }
}
