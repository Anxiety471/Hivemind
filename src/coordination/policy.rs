//! Deterministic persona selection and plan validation. No model involved.
use std::collections::{HashMap, HashSet};

use serde::Deserialize;

use super::model::{check_text, CoordError, CoordResult, TaskKind};
use crate::config::HivemindConfig;

#[derive(Debug, Clone)]
pub struct Persona {
    pub name: String,
    pub capabilities: Vec<String>,
    pub permissions: Vec<String>,
    pub workspace: String,
    /// Declares roles, so only its listed permissions apply (see `access::Grants::restricted`).
    pub restricted: bool,
    /// Configured reply order, the final tie-breaker.
    pub order: usize,
}

impl Persona {
    pub fn has_permission(&self, permission: &str) -> bool {
        self.permissions.iter().any(|p| p == permission)
    }
    /// May spawn sub-issues. Coordinators, researchers, and explicit delegators.
    /// A specialist assigned to do one ticket does not.
    pub fn may_decompose(&self) -> bool {
        self.has_permission("coordinate")
            || self.has_permission("decompose")
            || self.has_permission("delegate")
    }
    /// Splits its own ticket by default, then (unless it coordinates) synthesizes.
    /// The root coordinator is not included: they route once, from the root plan.
    pub fn plans_children_by_default(&self) -> bool {
        self.has_permission("coordinate") || self.has_permission("decompose")
    }
    /// Whether file changes are allowed: always for a persona without roles.
    pub fn may_write(&self) -> bool {
        !self.restricted || self.has_permission("workspace.write")
    }
    /// Permission check for task ownership: `workspace.write` is implied for a persona without roles.
    pub fn holds(&self, permission: &str) -> bool {
        if permission == "workspace.write" {
            self.may_write()
        } else {
            self.has_permission(permission)
        }
    }
    pub fn covers(&self, required: &[String]) -> usize {
        required
            .iter()
            .filter(|cap| self.capabilities.contains(cap))
            .count()
    }
}

pub fn normalize_tag(tag: &str) -> String {
    tag.trim().to_lowercase()
}

pub fn normalize_workspace(workspace: &str) -> String {
    let trimmed = workspace.trim();
    let trimmed = if trimmed.len() > 1 {
        trimmed.trim_end_matches('/')
    } else {
        trimmed
    };
    crate::config::absolute_workspace(trimmed)
}

#[derive(Debug, Clone, Default)]
pub struct Roster {
    personas: Vec<Persona>,
}

impl Roster {
    pub fn from_config(config: &HivemindConfig) -> Self {
        Self {
            personas: config
                .ordered_agents()
                .into_iter()
                .enumerate()
                .map(|(order, agent)| Persona {
                    name: agent.name.clone(),
                    capabilities: agent
                        .capabilities
                        .iter()
                        .map(|t| normalize_tag(t))
                        .collect(),
                    permissions: crate::access::resolve(agent, &config.roles).permissions,
                    workspace: normalize_workspace(&agent.workspace),
                    restricted: !agent.roles.is_empty(),
                    order,
                })
                .collect(),
        }
    }

    pub fn personas(&self) -> &[Persona] {
        &self.personas
    }

    pub fn get(&self, name: &str) -> Option<&Persona> {
        self.personas.iter().find(|p| p.name == name)
    }

    pub fn eligible_for_workspace(persona: &Persona, workspace: &str) -> bool {
        persona.workspace == normalize_workspace(workspace)
    }

    /// Best persona by: full capability coverage, workspace eligibility,
    /// required permission, then fewest active assignments, then configured
    /// order. `Err(missing)` lists what no eligible persona covers.
    pub fn select(
        &self,
        required: &[String],
        permission: Option<&str>,
        workspace: &str,
        load: &HashMap<String, u32>,
        exclude: &[&str],
    ) -> Result<&Persona, String> {
        let mut candidates: Vec<&Persona> = self
            .personas
            .iter()
            .filter(|p| !exclude.contains(&p.name.as_str()))
            .filter(|p| Self::eligible_for_workspace(p, workspace))
            .filter(|p| permission.is_none_or(|perm| p.holds(perm)))
            .collect();
        candidates.sort_by_key(|p| (load.get(&p.name).copied().unwrap_or(0), p.order));
        if let Some(found) = candidates
            .iter()
            .find(|p| p.covers(required) == required.len())
        {
            return Ok(found);
        }
        let covered: HashSet<&String> = candidates
            .iter()
            .flat_map(|p| p.capabilities.iter())
            .collect();
        let mut missing: Vec<String> = required
            .iter()
            .filter(|cap| !covered.contains(cap))
            .cloned()
            .collect();
        if missing.is_empty() && !required.is_empty() {
            missing = required.to_vec();
        }
        let mut reason = match permission {
            Some(perm) if candidates.is_empty() => {
                format!("no persona holds the '{perm}' permission in workspace '{workspace}'")
            }
            _ if candidates.is_empty() => {
                format!("no persona is eligible for workspace '{workspace}'")
            }
            _ => format!(
                "no single persona covers capabilities [{}]",
                missing.join(", ")
            ),
        };
        if reason.is_empty() {
            reason = "no eligible persona".into();
        }
        Err(reason)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanTask {
    pub key: String,
    pub objective: String,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub reviewer: Option<String>,
    /// Plan keys or ids of existing tasks under the same root.
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// Interface contract handed to dependants once this task completes.
    #[serde(default)]
    pub contract: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    /// Key of another task in this plan. The task is created as its sub-issue.
    /// Absent means a direct child of the task being planned.
    #[serde(default)]
    pub parent: Option<String>,
    /// `Some(false)` keeps the ticket a leaf. `Some(true)` and omitted both use
    /// the owner's default: a decomposer who is not the root coordinator plans
    /// sub-issues, and a specialist does the ticket. `Some(true)` on a
    /// specialist is ignored.
    #[serde(default)]
    pub breakdown: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub tasks: Vec<PlanTask>,
}

#[derive(Debug, Clone)]
pub struct ResolvedTask {
    pub key: String,
    pub objective: String,
    pub acceptance: Vec<String>,
    pub capabilities: Vec<String>,
    pub owner: String,
    pub reviewer: String,
    pub kind: TaskKind,
    pub contract: Option<String>,
    pub plan_deps: Vec<String>,
    pub existing_deps: Vec<String>,
    /// Key of the parent task in this plan, if this task is nested under one.
    pub parent_key: Option<String>,
    pub breakdown: Option<bool>,
}

pub struct PlanContext<'a> {
    pub roster: &'a Roster,
    pub workspace: &'a str,
    pub coordinator: &'a str,
    pub load: &'a HashMap<String, u32>,
    /// Tasks already under the root that new work may depend on.
    pub existing: &'a HashSet<String>,
    pub existing_count: usize,
    pub max_tasks: usize,
    pub max_depth: usize,
    /// Depth of the task the plan hangs from (root = 0).
    pub parent_depth: usize,
}

const MAX_OBJECTIVE: usize = 4000;
const MAX_CRITERION: usize = 600;
const MAX_CRITERIA: usize = 12;
const MAX_CAPS: usize = 8;
const MAX_CONTRACT: usize = 4000;

/// Validates a proposed graph and resolves owners/reviewers; returns tasks in
/// dependency order. Nothing is persisted here.
pub fn validate_plan(plan: &Plan, ctx: &PlanContext<'_>) -> CoordResult<Vec<ResolvedTask>> {
    if plan.tasks.is_empty() {
        return Err(CoordError::Invalid("plan has no tasks".into()));
    }
    if ctx.parent_depth + 1 > ctx.max_depth {
        return Err(CoordError::Invalid(format!(
            "plan would exceed the maximum task depth {}",
            ctx.max_depth
        )));
    }
    if plan.tasks.len() + ctx.existing_count > ctx.max_tasks {
        return Err(CoordError::Invalid(format!(
            "plan would exceed the {} task limit ({} already exist)",
            ctx.max_tasks, ctx.existing_count
        )));
    }
    let mut keys: HashMap<&str, usize> = HashMap::new();
    for (index, task) in plan.tasks.iter().enumerate() {
        let key = task.key.trim();
        if key.is_empty()
            || key.len() > 32
            || !key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(CoordError::Invalid(format!(
                "task key '{key}' must be 1-32 characters of [A-Za-z0-9_-]"
            )));
        }
        if key.starts_with("tk_") {
            return Err(CoordError::Invalid(format!(
                "task key '{key}' may not use the reserved tk_ prefix"
            )));
        }
        if keys.insert(key, index).is_some() {
            return Err(CoordError::Invalid(format!("duplicate task key '{key}'")));
        }
    }
    let mut resolved: Vec<ResolvedTask> = Vec::with_capacity(plan.tasks.len());
    for task in &plan.tasks {
        let key = task.key.trim().to_owned();
        let objective = check_text(
            &format!("task '{key}' objective"),
            &task.objective,
            MAX_OBJECTIVE,
        )?;
        if task.acceptance.is_empty() {
            return Err(CoordError::Invalid(format!(
                "task '{key}' needs at least one acceptance criterion"
            )));
        }
        if task.acceptance.len() > MAX_CRITERIA {
            return Err(CoordError::Invalid(format!(
                "task '{key}' has more than {MAX_CRITERIA} acceptance criteria"
            )));
        }
        let acceptance = task
            .acceptance
            .iter()
            .map(|c| {
                check_text(
                    &format!("task '{key}' acceptance criterion"),
                    c,
                    MAX_CRITERION,
                )
            })
            .collect::<CoordResult<Vec<_>>>()?;
        if task.capabilities.len() > MAX_CAPS {
            return Err(CoordError::Invalid(format!(
                "task '{key}' lists more than {MAX_CAPS} capabilities"
            )));
        }
        let capabilities: Vec<String> = task
            .capabilities
            .iter()
            .map(|c| normalize_tag(c))
            .filter(|c| !c.is_empty())
            .collect();
        let kind = match task.kind.as_deref() {
            None | Some("work") => TaskKind::Work,
            Some("integrate") => TaskKind::Integrate,
            Some(other) => {
                return Err(CoordError::Invalid(format!(
                    "task '{key}' has unknown kind '{other}'"
                )))
            }
        };
        let contract = task
            .contract
            .as_deref()
            .map(|c| check_text(&format!("task '{key}' contract"), c, MAX_CONTRACT))
            .transpose()?;
        let mut plan_deps = Vec::new();
        let mut existing_deps = Vec::new();
        for dep in &task.depends_on {
            let dep = dep.trim();
            if dep == key {
                return Err(CoordError::Invalid(format!(
                    "task '{key}' depends on itself"
                )));
            }
            if keys.contains_key(dep) {
                if !plan_deps.iter().any(|d| d == dep) {
                    plan_deps.push(dep.to_owned());
                }
            } else if ctx.existing.contains(dep) {
                if !existing_deps.iter().any(|d| d == dep) {
                    existing_deps.push(dep.to_owned());
                }
            } else {
                return Err(CoordError::Invalid(format!(
                    "task '{key}' depends on unknown task '{dep}'"
                )));
            }
        }
        let integrate = kind == TaskKind::Integrate;
        let can_own = |persona: &Persona| {
            if integrate {
                persona.holds("integrate")
            } else {
                // Specialists must be able to change the workspace. A decomposer
                // such as a researcher may own the ticket and spawn the people
                // who do the specialty work, then synthesize.
                persona.may_write() || persona.may_decompose()
            }
        };
        let owner = match task.owner.as_deref() {
            Some(name) => {
                let persona = ctx.roster.get(name).ok_or_else(|| {
                    CoordError::Invalid(format!(
                        "task '{key}' owner '{name}' is not a configured persona"
                    ))
                })?;
                if !Roster::eligible_for_workspace(persona, ctx.workspace) {
                    return Err(CoordError::Forbidden(format!(
                        "persona '{name}' is not eligible for workspace '{}'",
                        ctx.workspace
                    )));
                }
                if persona.covers(&capabilities) != capabilities.len() {
                    return Err(CoordError::Forbidden(format!(
                        "persona '{name}' lacks capabilities required by task '{key}'"
                    )));
                }
                if !can_own(persona) {
                    return Err(CoordError::Forbidden(format!(
                        "persona '{name}' cannot own task '{key}'"
                    )));
                }
                persona
            }
            None => {
                let permission = if integrate {
                    "integrate"
                } else {
                    "workspace.write"
                };
                match ctx.roster.select(
                    &capabilities,
                    Some(permission),
                    ctx.workspace,
                    ctx.load,
                    &[],
                ) {
                    Ok(persona) => persona,
                    Err(reason) if !integrate => ctx
                        .roster
                        .select(
                            &capabilities,
                            Some("decompose"),
                            ctx.workspace,
                            ctx.load,
                            &[],
                        )
                        .map_err(|_| {
                            CoordError::Invalid(format!(
                                "task '{key}' has no eligible owner: {reason}"
                            ))
                        })?,
                    Err(reason) => {
                        return Err(CoordError::Invalid(format!(
                            "task '{key}' has no eligible owner: {reason}"
                        )))
                    }
                }
            }
        };
        if !can_own(owner) {
            return Err(CoordError::Forbidden(format!(
                "persona '{}' cannot own task '{key}'",
                owner.name
            )));
        }
        let reviewer = match task.reviewer.as_deref() {
            Some(name) => {
                let persona = ctx.roster.get(name).ok_or_else(|| {
                    CoordError::Invalid(format!(
                        "task '{key}' reviewer '{name}' is not a configured persona"
                    ))
                })?;
                if !persona.has_permission("review") && persona.name != ctx.coordinator {
                    return Err(CoordError::Forbidden(format!(
                        "persona '{name}' lacks the 'review' permission"
                    )));
                }
                if !Roster::eligible_for_workspace(persona, ctx.workspace) {
                    return Err(CoordError::Forbidden(format!(
                        "persona '{name}' is not eligible for workspace '{}'",
                        ctx.workspace
                    )));
                }
                if persona.name == owner.name && ctx.roster.personas().len() > 1 {
                    return Err(CoordError::Invalid(format!(
                        "task '{key}' reviewer must differ from its owner"
                    )));
                }
                persona.name.clone()
            }
            None => ctx
                .roster
                .select(
                    &[],
                    Some("review"),
                    ctx.workspace,
                    ctx.load,
                    &[owner.name.as_str()],
                )
                .map(|p| p.name.clone())
                .unwrap_or_else(|_| ctx.coordinator.to_owned()),
        };
        let parent_key = task
            .parent
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_owned);
        resolved.push(ResolvedTask {
            key,
            objective,
            acceptance,
            capabilities,
            owner: owner.name.clone(),
            reviewer,
            kind,
            contract,
            plan_deps,
            existing_deps,
            parent_key,
            breakdown: task.breakdown,
        });
    }
    check_parent_tree(&resolved, ctx.parent_depth, ctx.max_depth)?;
    order_and_check_depth(resolved, ctx.max_depth)
}

/// Parent links nest sub-issues. Rejects cycles, unknown parents, a dependency
/// between a task and its ancestor, and a chain past `max_depth`.
fn check_parent_tree(
    tasks: &[ResolvedTask],
    parent_depth: usize,
    max_depth: usize,
) -> CoordResult<()> {
    let by_key: HashMap<&str, &ResolvedTask> = tasks.iter().map(|t| (t.key.as_str(), t)).collect();
    for task in tasks {
        let ancestors = ancestor_keys(&task.key, &by_key)?;
        let depth = ancestors.len() + 1;
        if parent_depth + depth > max_depth {
            return Err(CoordError::Invalid(format!(
                "task '{}' would reach depth {}, past the maximum {max_depth}",
                task.key,
                parent_depth + depth
            )));
        }
        for dep in &task.plan_deps {
            if ancestors.iter().any(|a| a == dep) {
                return Err(CoordError::Invalid(format!(
                    "task '{}' cannot depend on ancestor '{dep}'",
                    task.key
                )));
            }
            let dep_ancestors = ancestor_keys(dep, &by_key)?;
            if dep_ancestors.iter().any(|a| a == &task.key) {
                return Err(CoordError::Invalid(format!(
                    "task '{}' cannot depend on descendant '{dep}'",
                    task.key
                )));
            }
        }
    }
    Ok(())
}

/// Parents from nearest to furthest. Errors on an unknown parent or a cycle.
fn ancestor_keys(key: &str, by_key: &HashMap<&str, &ResolvedTask>) -> CoordResult<Vec<String>> {
    let mut out = Vec::new();
    let mut cursor = key.to_owned();
    for _ in 0..by_key.len() {
        let Some(task) = by_key.get(cursor.as_str()) else {
            return Err(CoordError::Invalid(format!(
                "task '{cursor}' is not in this plan"
            )));
        };
        let Some(parent) = task.parent_key.clone() else {
            return Ok(out);
        };
        if parent == key || out.iter().any(|a| a == &parent) {
            return Err(CoordError::Invalid(format!(
                "plan has a parent cycle involving '{key}'"
            )));
        }
        if !by_key.contains_key(parent.as_str()) {
            return Err(CoordError::Invalid(format!(
                "task '{cursor}' parent '{parent}' is not a task in this plan"
            )));
        }
        cursor = parent.clone();
        out.push(parent);
    }
    Err(CoordError::Invalid(format!(
        "plan has a parent cycle involving '{key}'"
    )))
}

/// Kahn's algorithm: rejects cycles, returns dependency order, bounds chain length.
fn order_and_check_depth(
    tasks: Vec<ResolvedTask>,
    max_depth: usize,
) -> CoordResult<Vec<ResolvedTask>> {
    let index: HashMap<String, usize> = tasks
        .iter()
        .enumerate()
        .map(|(i, t)| (t.key.clone(), i))
        .collect();
    let mut indegree: Vec<usize> = tasks.iter().map(|t| t.plan_deps.len()).collect();
    let mut dependants: Vec<Vec<usize>> = vec![Vec::new(); tasks.len()];
    for (i, task) in tasks.iter().enumerate() {
        for dep in &task.plan_deps {
            dependants[index[dep]].push(i);
        }
    }
    let mut queue: Vec<usize> = (0..tasks.len()).filter(|i| indegree[*i] == 0).collect();
    let mut order = Vec::with_capacity(tasks.len());
    let mut chain = vec![1usize; tasks.len()];
    while let Some(next) = queue.pop() {
        order.push(next);
        for &dependant in &dependants[next] {
            chain[dependant] = chain[dependant].max(chain[next] + 1);
            indegree[dependant] -= 1;
            if indegree[dependant] == 0 {
                queue.push(dependant);
            }
        }
    }
    if order.len() != tasks.len() {
        let stuck: Vec<&str> = (0..tasks.len())
            .filter(|i| indegree[*i] > 0)
            .map(|i| tasks[i].key.as_str())
            .collect();
        return Err(CoordError::Invalid(format!(
            "plan has a dependency cycle involving [{}]",
            stuck.join(", ")
        )));
    }
    if let Some(longest) = chain.iter().max() {
        if *longest > max_depth {
            return Err(CoordError::Invalid(format!(
                "dependency chain of {longest} tasks exceeds the maximum depth {max_depth}"
            )));
        }
    }
    let mut slots: Vec<Option<ResolvedTask>> = tasks.into_iter().map(Some).collect();
    Ok(order.into_iter().filter_map(|i| slots[i].take()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn persona(name: &str, caps: &[&str], perms: &[&str], order: usize) -> Persona {
        Persona {
            name: name.into(),
            capabilities: caps.iter().map(|c| c.to_string()).collect(),
            permissions: perms.iter().map(|c| c.to_string()).collect(),
            workspace: normalize_workspace("."),
            restricted: false,
            order,
        }
    }

    fn roster() -> Roster {
        Roster {
            personas: vec![
                persona("Lead", &[], &["coordinate", "delegate", "review"], 0),
                persona("Front", &["frontend"], &[], 1),
                persona("Back", &["backend"], &[], 2),
                persona("Back2", &["backend"], &[], 3),
                persona("Integrator", &["frontend", "backend"], &["integrate"], 4),
            ],
        }
    }

    fn task(key: &str, caps: &[&str], deps: &[&str]) -> PlanTask {
        PlanTask {
            key: key.into(),
            objective: format!("do {key}"),
            acceptance: vec!["works".into()],
            capabilities: caps.iter().map(|c| c.to_string()).collect(),
            owner: None,
            reviewer: None,
            depends_on: deps.iter().map(|c| c.to_string()).collect(),
            contract: None,
            kind: None,
            parent: None,
            breakdown: None,
        }
    }

    fn validate(plan: &Plan, load: &HashMap<String, u32>) -> CoordResult<Vec<ResolvedTask>> {
        let roster = roster();
        let existing = HashSet::new();
        validate_plan(
            plan,
            &PlanContext {
                roster: &roster,
                workspace: ".",
                coordinator: "Lead",
                load,
                existing: &existing,
                existing_count: 0,
                max_tasks: 8,
                max_depth: 3,
                parent_depth: 0,
            },
        )
    }

    #[test]
    fn selection_prefers_less_loaded_then_configured_order() {
        let roster = roster();
        let caps = vec!["backend".to_string()];
        let empty = HashMap::new();
        assert_eq!(
            roster.select(&caps, None, ".", &empty, &[]).unwrap().name,
            "Back"
        );
        let load = HashMap::from([("Back".to_string(), 2)]);
        assert_eq!(
            roster.select(&caps, None, ".", &load, &[]).unwrap().name,
            "Back2"
        );
        let missing = roster
            .select(&["ml".to_string()], None, ".", &empty, &[])
            .unwrap_err();
        assert!(missing.contains("ml"), "{missing}");
        assert!(roster
            .select(&caps, None, "/elsewhere", &empty, &[])
            .is_err());
    }

    #[test]
    fn plan_resolves_owners_and_independent_reviewers() {
        let plan = Plan {
            tasks: vec![
                task("api", &["backend"], &[]),
                task("ui", &["frontend"], &["api"]),
            ],
        };
        let resolved = validate(&plan, &HashMap::new()).unwrap();
        assert_eq!(resolved[0].key, "api");
        assert_eq!(
            (resolved[0].owner.as_str(), resolved[0].reviewer.as_str()),
            ("Back", "Lead")
        );
        assert_eq!(resolved[1].owner, "Front");
    }

    #[test]
    fn cycles_unknown_deps_missing_skills_and_oversize_are_rejected() {
        let cyc = Plan {
            tasks: vec![task("a", &[], &["b"]), task("b", &[], &["a"])],
        };
        assert!(validate(&cyc, &HashMap::new())
            .unwrap_err()
            .to_string()
            .contains("cycle"));
        let unknown = Plan {
            tasks: vec![task("a", &[], &["zzz"])],
        };
        assert!(validate(&unknown, &HashMap::new()).is_err());
        let missing = Plan {
            tasks: vec![task("a", &["ml"], &[])],
        };
        assert!(validate(&missing, &HashMap::new())
            .unwrap_err()
            .to_string()
            .contains("ml"));
        let deep = Plan {
            tasks: vec![
                task("a", &[], &[]),
                task("b", &[], &["a"]),
                task("c", &[], &["b"]),
                task("d", &[], &["c"]),
            ],
        };
        assert!(validate(&deep, &HashMap::new())
            .unwrap_err()
            .to_string()
            .contains("depth"));
        let wide = Plan {
            tasks: (0..9).map(|i| task(&format!("t{i}"), &[], &[])).collect(),
        };
        assert!(validate(&wide, &HashMap::new()).is_err());
        let mut no_criteria = task("a", &[], &[]);
        no_criteria.acceptance.clear();
        assert!(validate(
            &Plan {
                tasks: vec![no_criteria]
            },
            &HashMap::new()
        )
        .is_err());
    }

    #[test]
    fn explicit_owner_cannot_exceed_its_capabilities_or_permissions() {
        let mut wrong = task("a", &["backend"], &[]);
        wrong.owner = Some("Front".into());
        assert!(matches!(
            validate(&Plan { tasks: vec![wrong] }, &HashMap::new()),
            Err(CoordError::Forbidden(_))
        ));
        let mut integ = task("i", &[], &[]);
        integ.kind = Some("integrate".into());
        integ.owner = Some("Back".into());
        assert!(matches!(
            validate(&Plan { tasks: vec![integ] }, &HashMap::new()),
            Err(CoordError::Forbidden(_))
        ));
        let mut integ = task("i", &[], &[]);
        integ.kind = Some("integrate".into());
        let resolved = validate(&Plan { tasks: vec![integ] }, &HashMap::new()).unwrap();
        assert_eq!(resolved[0].owner, "Integrator");
    }

    #[test]
    fn read_only_personas_never_own_work_but_persona_without_roles_may() {
        let restricted = |name: &str, perms: &[&str], order| Persona {
            restricted: true,
            ..persona(name, &["x"], perms, order)
        };
        let roster = Roster {
            personas: vec![
                restricted("Res", &[], 0),
                restricted("Impl", &["workspace.write"], 1),
                persona("Legacy", &["x"], &[], 2),
            ],
        };
        let empty = HashMap::new();
        let caps = vec!["x".to_string()];
        assert_eq!(
            roster
                .select(&caps, Some("workspace.write"), ".", &empty, &[])
                .unwrap()
                .name,
            "Impl"
        );
        assert_eq!(
            roster
                .select(&caps, Some("workspace.write"), ".", &empty, &["Impl"])
                .unwrap()
                .name,
            "Legacy"
        );
        assert!(
            roster
                .select(
                    &caps,
                    Some("workspace.write"),
                    ".",
                    &empty,
                    &["Impl", "Legacy"]
                )
                .is_err(),
            "a researcher is never picked to write"
        );
        assert!(
            !roster.get("Res").unwrap().may_write() && roster.get("Legacy").unwrap().may_write()
        );
    }

    #[test]
    fn a_writer_beats_a_researcher_who_covers_the_same_capability() {
        let restricted = |name: &str, caps: &[&str], perms: &[&str], order| Persona {
            name: name.into(),
            capabilities: caps.iter().map(|c| c.to_string()).collect(),
            permissions: perms.iter().map(|c| c.to_string()).collect(),
            workspace: normalize_workspace("."),
            restricted: true,
            order,
        };
        let with_writer = Roster {
            personas: vec![
                persona("Lead", &[], &["coordinate", "review"], 0),
                restricted("Writer", &["research"], &["workspace.write"], 1),
                restricted("Researcher", &["research"], &["decompose"], 2),
            ],
        };
        let research_only = Roster {
            personas: vec![
                persona("Lead", &[], &["coordinate", "review"], 0),
                restricted("Researcher", &["research"], &["decompose"], 1),
            ],
        };
        let existing = HashSet::new();
        let load = HashMap::new();
        let plan = Plan {
            tasks: vec![task("findings", &["research"], &[])],
        };
        let owner_of = |roster: &Roster| {
            validate_plan(
                &plan,
                &PlanContext {
                    roster,
                    workspace: ".",
                    coordinator: "Lead",
                    load: &load,
                    existing: &existing,
                    existing_count: 0,
                    max_tasks: 8,
                    max_depth: 3,
                    parent_depth: 0,
                },
            )
            .unwrap()[0]
                .owner
                .clone()
        };
        assert_eq!(owner_of(&with_writer), "Writer");
        assert_eq!(owner_of(&research_only), "Researcher");
    }
}
