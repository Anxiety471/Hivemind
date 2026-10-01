//! Persona access control: permissions, roles, and the audit log.
//!
//! A persona's authority is the union of its roles' permissions and its direct
//! `permissions`, expanded by [`IMPLIES`]. Hivemind decides in Rust; a model
//! never grants, chooses, or names identity. `role`/`member_roles` strings stay
//! descriptive prompt text and grant nothing.
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::config::{AgentConfig, HivemindConfig, RoleConfig, ToolAccess};

pub const PERMISSIONS: &[&str] = &[
    "coordinate",
    "delegate",
    "review",
    "integrate",
    "memory.private.write",
    "memory.group.write",
    "memory.persona.write",
    "memory.global.write",
    "memory.archive",
    "task.decide",
    "task.reassign",
    "group.manage",
    "workspace.write",
    "workspace.exec",
];

/// Built-in roles. Custom `[roles.<name>]` entries cannot reuse these names.
/// Only `worker`, `implementor`, `integrator`, and `writer` may edit files; `tester` may run shell
/// but not use edit tools. `researcher`, `reviewer`, `coordinator`, `orchestrator`, `lead`,
/// `leader`, `curator`, and `observer` are read-only.
pub const BUILTIN_ROLES: &[(&str, &[&str])] = &[
    ("observer", &[]),
    (
        "worker",
        &[
            "workspace.write",
            "workspace.exec",
            "memory.private.write",
            "memory.group.write",
        ],
    ),
    (
        "implementor",
        &[
            "workspace.write",
            "workspace.exec",
            "memory.private.write",
            "memory.group.write",
        ],
    ),
    (
        "researcher",
        &["memory.private.write", "memory.group.write"],
    ),
    ("reviewer", &["review", "memory.private.write"]),
    (
        "coordinator",
        &["coordinate", "memory.private.write", "memory.group.write"],
    ),
    (
        "integrator",
        &[
            "integrate",
            "workspace.write",
            "workspace.exec",
            "memory.private.write",
        ],
    ),
    (
        "curator",
        &[
            "memory.persona.write",
            "memory.global.write",
            "memory.archive",
            "memory.private.write",
            "memory.group.write",
        ],
    ),
    (
        "lead",
        &[
            "coordinate",
            "review",
            "memory.private.write",
            "memory.group.write",
        ],
    ),
    // Pure delegator: plans, delegates, decides, and archives, but never touches files.
    (
        "orchestrator",
        &[
            "coordinate",
            "task.decide",
            "memory.private.write",
            "memory.group.write",
            "memory.archive",
        ],
    ),
    // Observer with a voice: watches, reviews, and decides tasks; never edits and does not plan.
    (
        "leader",
        &["review", "memory.private.write", "memory.group.write"],
    ),
    // Runs builds and tests (shell) but has no edit tools; shell can still write, so it is not a hard read-only.
    (
        "tester",
        &[
            "workspace.exec",
            "memory.private.write",
            "memory.group.write",
        ],
    ),
    // Edits files (docs, content) but has no shell.
    (
        "writer",
        &[
            "workspace.write",
            "memory.private.write",
            "memory.group.write",
        ],
    ),
];

/// Holding the left permission also holds each listed permission. Lists are
/// already transitive, so expansion is a single pass. `coordinate` does not
/// imply `task.decide`: that would widen who is offered `tasks.decide`.
const IMPLIES: &[(&str, &[&str])] = &[
    ("coordinate", &["delegate", "group.manage", "task.reassign"]),
    ("delegate", &["group.manage", "task.reassign"]),
    ("review", &["task.decide"]),
];

const AUDIT_KEEP: i64 = 10_000;
const AUDIT_PRUNE_EVERY: u64 = 256;

/// Effective authority of one persona.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Grants {
    pub roles: Vec<String>,
    /// Effective permissions after implication, sorted.
    pub permissions: Vec<String>,
    /// A persona that declares roles is deny-by-default for gated memory tools.
    /// One without roles keeps the historical unrestricted memory behavior.
    pub restricted: bool,
}

impl Grants {
    pub fn has(&self, permission: &str) -> bool {
        self.permissions.iter().any(|p| p == permission)
    }
}

fn role_permissions<'a>(
    name: &str,
    custom: &'a BTreeMap<String, RoleConfig>,
) -> Option<Vec<&'a str>> {
    if let Some((_, permissions)) = BUILTIN_ROLES.iter().find(|(role, _)| *role == name) {
        return Some(permissions.to_vec());
    }
    custom
        .get(name)
        .map(|role| role.permissions.iter().map(String::as_str).collect())
}

/// Effective grants for `agent`. Validation guarantees every role resolves.
pub fn resolve(agent: &AgentConfig, custom: &BTreeMap<String, RoleConfig>) -> Grants {
    let mut set: BTreeSet<String> = agent.permissions.iter().cloned().collect();
    for role in &agent.roles {
        set.extend(
            role_permissions(role, custom)
                .unwrap_or_default()
                .into_iter()
                .map(str::to_owned),
        );
    }
    let direct: Vec<String> = set.iter().cloned().collect();
    for permission in direct {
        if let Some((_, implied)) = IMPLIES.iter().find(|(held, _)| *held == permission) {
            set.extend(implied.iter().map(|p| (*p).to_owned()));
        }
    }
    Grants {
        roles: agent.roles.clone(),
        permissions: set.into_iter().collect(),
        restricted: !agent.roles.is_empty(),
    }
}

/// Runtime tool restriction for `agent`. `None` (unrestricted) when the persona
/// declares no roles, or holds both `workspace.write` and `workspace.exec`.
pub fn tool_access(
    agent: &AgentConfig,
    custom: &BTreeMap<String, RoleConfig>,
) -> Option<ToolAccess> {
    let grants = resolve(agent, custom);
    let access = ToolAccess {
        write: grants.has("workspace.write"),
        exec: grants.has("workspace.exec"),
    };
    (grants.restricted && !(access.write && access.exec)).then_some(access)
}

pub fn validate(config: &HivemindConfig) -> Result<()> {
    for (name, role) in &config.roles {
        if name.trim().is_empty() || name.trim() != name {
            bail!("role names must be non-empty and free of surrounding whitespace; got {name:?}");
        }
        if BUILTIN_ROLES.iter().any(|(builtin, _)| builtin == name) {
            bail!("role '{name}' is built in and cannot be redefined; choose another name");
        }
        for permission in &role.permissions {
            if !PERMISSIONS.contains(&permission.as_str()) {
                bail!(
                    "role '{name}' has unknown permission '{permission}'; allowed: {}",
                    PERMISSIONS.join(", ")
                );
            }
        }
    }
    for persona in &config.agents {
        for permission in &persona.permissions {
            if !PERMISSIONS.contains(&permission.as_str()) {
                bail!(
                    "persona '{}' has unknown permission '{permission}'; allowed: {}",
                    persona.name,
                    PERMISSIONS.join(", ")
                );
            }
        }
        for role in &persona.roles {
            if role_permissions(role, &config.roles).is_none() {
                let known: Vec<&str> = BUILTIN_ROLES
                    .iter()
                    .map(|(name, _)| *name)
                    .chain(config.roles.keys().map(String::as_str))
                    .collect();
                bail!(
                    "persona '{}' has unknown role '{role}'; known roles: {}",
                    persona.name,
                    known.join(", ")
                );
            }
        }
    }
    Ok(())
}

/// Permission a memory tool needs; `None` for ungated tools such as `memory.search`.
pub fn memory_permission(tool: &str) -> Option<&'static str> {
    Some(match tool {
        "memory.private.add" | "memory.private.update" | "memory.private.upsert" => {
            "memory.private.write"
        }
        "memory.group.add" | "memory.group.update" | "memory.group.upsert" => "memory.group.write",
        "memory.persona.propose" | "memory.persona.update" => "memory.persona.write",
        "memory.global.propose" | "memory.global.update" => "memory.global.write",
        "memory.archive" => "memory.archive",
        _ => return None,
    })
}

/// Permission a workspace tool needs; `None` for reads (`workspace.get`, `workspace.list`).
/// Changing a group's shared workspace moves every member, so it needs `group.manage`;
/// moving a persona's own workspace needs `workspace.write`.
pub fn workspace_permission(tool: &str, group: bool) -> Option<&'static str> {
    match tool {
        "workspace.set" | "workspace.clear" if group => Some("group.manage"),
        "workspace.set" => Some("workspace.write"),
        _ => None,
    }
}

/// Permission label recorded for a coordination tool call.
pub fn coordination_permission(tool: &str, args: &serde_json::Value) -> Option<&'static str> {
    Some(match tool {
        "groups.create" | "groups.members.update" => "group.manage",
        "tasks.decide" => "task.decide",
        "tasks.delegate" if args.get("task").is_some_and(|task| !task.is_null()) => "task.reassign",
        "tasks.delegate" => "delegate",
        _ => return None,
    })
}

/// Every persona's grants plus the audit log.
pub struct AccessPolicy {
    grants: HashMap<String, Grants>,
    audit: std::sync::Arc<Audit>,
}

impl AccessPolicy {
    pub fn from_config(config: &HivemindConfig, audit: std::sync::Arc<Audit>) -> Self {
        let grants = config
            .agents
            .iter()
            .map(|agent| (agent.name.clone(), resolve(agent, &config.roles)))
            .collect();
        Self { grants, audit }
    }

    pub fn grants(&self, persona: &str) -> Option<&Grants> {
        self.grants.get(persona)
    }

    /// All personas' grants, sorted by name.
    pub fn all(&self) -> Vec<(&str, &Grants)> {
        let mut all: Vec<_> = self
            .grants
            .iter()
            .map(|(name, grants)| (name.as_str(), grants))
            .collect();
        all.sort_by_key(|(name, _)| *name);
        all
    }

    pub fn audit(&self) -> &std::sync::Arc<Audit> {
        &self.audit
    }

    /// Authorize a memory tool for `persona`; every gated call is audited.
    /// Ungated tools (search) pass without a record.
    pub fn authorize_memory(&self, persona: &str, resource: &str, tool: &str) -> Result<()> {
        match memory_permission(tool) {
            Some(permission) => self.authorize(persona, permission, tool, resource),
            None => Ok(()),
        }
    }

    /// Authorize a workspace tool for `persona` in a group (`group`) or solo
    /// room; every gated call is audited. Reads (`get`, `list`) are ungated.
    pub fn authorize_workspace(
        &self,
        persona: &str,
        resource: &str,
        tool: &str,
        group: bool,
    ) -> Result<()> {
        match workspace_permission(tool, group) {
            Some(permission) => self.authorize(persona, permission, tool, resource),
            None => Ok(()),
        }
    }

    /// Whether `persona` would pass a gate on `permission`, without an audit record.
    pub fn allows(&self, persona: &str, permission: &str) -> bool {
        self.grants
            .get(persona)
            .is_some_and(|grants| !grants.restricted || grants.has(permission))
    }

    fn authorize(
        &self,
        persona: &str,
        permission: &str,
        action: &str,
        resource: &str,
    ) -> Result<()> {
        let (allowed, reason) = match self.grants.get(persona) {
            None => (false, "unknown persona".to_owned()),
            Some(grants) if !grants.restricted => {
                (true, "no roles declared; unrestricted".to_owned())
            }
            Some(grants) if grants.has(permission) => (
                true,
                format!("granted by roles [{}]", grants.roles.join(", ")),
            ),
            Some(grants) => (
                false,
                format!("roles [{}] lack '{permission}'", grants.roles.join(", ")),
            ),
        };
        self.audit
            .record(persona, permission, action, resource, allowed, &reason);
        if allowed {
            Ok(())
        } else {
            bail!("permission denied: persona '{persona}' lacks '{permission}' for {action}")
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AuditEntry {
    pub id: i64,
    pub at: i64,
    pub persona: String,
    pub permission: String,
    pub action: String,
    pub resource: String,
    pub allowed: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Default)]
pub struct AuditFilter {
    pub persona: Option<String>,
    pub denied_only: bool,
    pub limit: usize,
}

/// Bounded SQLite record of gated decisions (newest [`AUDIT_KEEP`] rows).
/// A failed write is reported on stderr and never changes the decision.
pub struct Audit {
    conn: Mutex<Connection>,
    writes: AtomicU64,
}

impl Audit {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path.as_ref())?;
        conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0))?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Self::init(conn)
    }

    pub fn in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS access_audit (
               id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, persona TEXT NOT NULL,
               permission TEXT NOT NULL, action TEXT NOT NULL, resource TEXT NOT NULL,
               allowed INTEGER NOT NULL, reason TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS access_audit_persona ON access_audit(persona, id);",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
            writes: AtomicU64::new(0),
        })
    }

    pub fn record(
        &self,
        persona: &str,
        permission: &str,
        action: &str,
        resource: &str,
        allowed: bool,
        reason: &str,
    ) {
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let conn = self.conn.lock();
        let inserted = conn.execute(
            "INSERT INTO access_audit(at,persona,permission,action,resource,allowed,reason) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![at, persona, permission, action, resource, allowed, reason],
        );
        if let Err(error) = inserted {
            eprintln!("hivemind: access audit write failed: {error}");
            return;
        }
        if self.writes.fetch_add(1, Ordering::Relaxed) % AUDIT_PRUNE_EVERY == AUDIT_PRUNE_EVERY - 1
        {
            let _ = conn.execute(
                "DELETE FROM access_audit WHERE id <= (SELECT MAX(id) FROM access_audit) - ?1",
                [AUDIT_KEEP],
            );
        }
    }

    /// Newest first.
    pub fn list(&self, filter: &AuditFilter) -> Result<Vec<AuditEntry>> {
        let conn = self.conn.lock();
        let mut statement = conn.prepare_cached(
            "SELECT id,at,persona,permission,action,resource,allowed,reason FROM access_audit
             WHERE (?1 IS NULL OR persona = ?1) AND (?2 = 0 OR allowed = 0) ORDER BY id DESC LIMIT ?3",
        )?;
        let limit = filter.limit.clamp(1, 1000) as i64;
        let rows =
            statement.query_map(params![filter.persona, filter.denied_only, limit], |row| {
                Ok(AuditEntry {
                    id: row.get(0)?,
                    at: row.get(1)?,
                    persona: row.get(2)?,
                    permission: row.get(3)?,
                    action: row.get(4)?,
                    resource: row.get(5)?,
                    allowed: row.get(6)?,
                    reason: row.get(7)?,
                })
            })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn config(agents: &[(&str, &[&str], &[&str])], roles: &[(&str, &[&str])]) -> HivemindConfig {
        let mut config = HivemindConfig::default_poc();
        config.agents = agents
            .iter()
            .map(|(name, roles, permissions)| {
                let mut agent = config_agent(name);
                agent.roles = roles.iter().map(|r| r.to_string()).collect();
                agent.permissions = permissions.iter().map(|p| p.to_string()).collect();
                agent
            })
            .collect();
        config.conversation.reply_order.clear();
        config.roles = roles
            .iter()
            .map(|(n, p)| {
                (
                    n.to_string(),
                    RoleConfig {
                        permissions: p.iter().map(|p| p.to_string()).collect(),
                    },
                )
            })
            .collect();
        config
    }

    fn config_agent(name: &str) -> AgentConfig {
        let mut agent = HivemindConfig::default_poc().agents[0].clone();
        agent.name = name.into();
        agent.roles = Vec::new();
        agent.permissions = Vec::new();
        agent
    }

    fn policy(config: &HivemindConfig) -> AccessPolicy {
        AccessPolicy::from_config(config, Arc::new(Audit::in_memory().unwrap()))
    }

    #[test]
    fn roles_and_direct_grants_union_and_imply() {
        let config = config(
            &[
                ("A", &["worker", "qa"], &["delegate"]),
                ("B", &[], &["review"]),
                ("C", &["coordinator"], &[]),
            ],
            &[("qa", &["review"])],
        );
        validate(&config).unwrap();
        let policy = policy(&config);
        let a = policy.grants("A").unwrap();
        assert!(a.has("memory.private.write") && a.has("review") && a.has("delegate"));
        assert!(
            a.has("group.manage") && a.has("task.reassign"),
            "delegate implies both"
        );
        assert!(a.has("task.decide"), "review implies task.decide");
        assert!(a.restricted);
        let b = policy.grants("B").unwrap();
        assert!(
            b.has("task.decide") && !b.restricted,
            "no roles keeps legacy memory behavior"
        );
        assert!(
            !policy.grants("C").unwrap().has("task.decide"),
            "coordinate does not imply task.decide"
        );
    }

    #[test]
    fn default_roles_decide_which_runtime_tools_a_persona_keeps() {
        let config = config(
            &[
                ("Impl", &["implementor"], &[]),
                ("Res", &["researcher"], &[]),
                ("Legacy", &[], &[]),
                ("Exec", &["researcher"], &["workspace.exec"]),
                ("Rev", &["reviewer", "qa"], &[]),
                ("Orch", &["orchestrator"], &[]),
                ("Lead", &["leader"], &[]),
            ],
            &[("qa", &["workspace.write"])],
        );
        validate(&config).unwrap();
        let of = |name: &str| {
            tool_access(
                config.agents.iter().find(|a| a.name == name).unwrap(),
                &config.roles,
            )
        };
        assert_eq!(of("Impl"), None, "implementor keeps every tool");
        assert_eq!(
            of("Res"),
            Some(ToolAccess {
                write: false,
                exec: false
            }),
            "researcher is read-only"
        );
        assert_eq!(of("Legacy"), None, "no roles stays unrestricted");
        assert_eq!(
            of("Exec"),
            Some(ToolAccess {
                write: false,
                exec: true
            }),
            "direct grants add to the role"
        );
        assert_eq!(
            of("Rev"),
            Some(ToolAccess {
                write: true,
                exec: false
            }),
            "custom roles can grant workspace permissions"
        );
        assert_eq!(
            of("Orch"),
            Some(ToolAccess {
                write: false,
                exec: false
            }),
            "orchestrator delegates, never edits"
        );
        assert_eq!(
            of("Lead"),
            Some(ToolAccess {
                write: false,
                exec: false
            }),
            "leader observes and decides but never edits"
        );
        let grants = resolve(
            config.agents.iter().find(|a| a.name == "Lead").unwrap(),
            &config.roles,
        );
        assert!(
            grants.has("review") && grants.has("task.decide") && !grants.has("coordinate"),
            "leader signs off, does not plan"
        );
        let builtin = |role: &str| {
            tool_access(
                &AgentConfig {
                    roles: vec![role.into()],
                    ..config_agent("X")
                },
                &config.roles,
            )
        };
        assert_eq!(
            builtin("tester"),
            Some(ToolAccess {
                write: false,
                exec: true
            })
        );
        assert_eq!(
            builtin("writer"),
            Some(ToolAccess {
                write: true,
                exec: false
            })
        );
        let grants = resolve(
            config.agents.iter().find(|a| a.name == "Orch").unwrap(),
            &config.roles,
        );
        assert!(
            grants.has("coordinate")
                && grants.has("delegate")
                && grants.has("task.decide")
                && !grants.has("review")
        );
    }

    #[test]
    fn validation_names_the_offending_persona_or_role() {
        let unknown_role = config(&[("A", &["ghost"], &[])], &[]);
        assert!(validate(&unknown_role)
            .unwrap_err()
            .to_string()
            .contains("persona 'A' has unknown role 'ghost'"));
        let bad_permission = config(&[("A", &[], &["root"])], &[]);
        assert!(validate(&bad_permission)
            .unwrap_err()
            .to_string()
            .contains("unknown permission 'root'"));
        let shadow = config(&[("A", &[], &[])], &[("worker", &[])]);
        assert!(validate(&shadow)
            .unwrap_err()
            .to_string()
            .contains("built in"));
        let bad_role_permission = config(&[("A", &[], &[])], &[("qa", &["nope"])]);
        assert!(validate(&bad_role_permission)
            .unwrap_err()
            .to_string()
            .contains("role 'qa' has unknown permission 'nope'"));
    }

    #[test]
    fn memory_gate_is_deny_by_default_only_for_roled_personas_and_audited() {
        let config = config(
            &[
                ("Legacy", &[], &[]),
                ("Watcher", &["observer"], &[]),
                ("Worker", &["worker"], &[]),
                ("Curator", &["curator"], &[]),
            ],
            &[],
        );
        let policy = policy(&config);
        assert!(policy
            .authorize_memory("Legacy", "r", "memory.global.propose")
            .is_ok());
        assert!(
            policy
                .authorize_memory("Watcher", "r", "memory.search")
                .is_ok(),
            "search is ungated"
        );
        assert!(policy
            .authorize_memory("Watcher", "r", "memory.private.add")
            .is_err());
        assert!(policy
            .authorize_memory("Worker", "r", "memory.private.add")
            .is_ok());
        assert!(policy
            .authorize_memory("Worker", "r", "memory.group.upsert")
            .is_ok());
        assert!(policy
            .authorize_memory("Worker", "r", "memory.global.propose")
            .is_err());
        assert!(policy
            .authorize_memory("Worker", "r", "memory.archive")
            .is_err());
        assert!(policy
            .authorize_memory("Curator", "r", "memory.global.update")
            .is_ok());
        assert!(
            policy
                .authorize_memory("Nobody", "r", "memory.private.add")
                .is_err(),
            "unknown personas are denied"
        );
        let denied = policy
            .audit()
            .list(&AuditFilter {
                denied_only: true,
                limit: 50,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(denied.len(), 4);
        assert!(denied.iter().all(|e| !e.allowed && !e.reason.is_empty()));
        assert!(denied
            .iter()
            .any(|e| e.persona == "Worker" && e.permission == "memory.archive"));
        let watcher = policy
            .audit()
            .list(&AuditFilter {
                persona: Some("Watcher".into()),
                limit: 50,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(watcher.len(), 1, "the ungated search left no record");
    }

    #[test]
    fn audit_prunes_to_the_newest_rows() {
        let audit = Audit::in_memory().unwrap();
        for i in 0..(AUDIT_KEEP as u64 + AUDIT_PRUNE_EVERY) {
            audit.record("P", "x", "a", &i.to_string(), true, "");
        }
        let newest = audit
            .list(&AuditFilter {
                limit: 1000,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            newest[0].resource,
            (AUDIT_KEEP as u64 + AUDIT_PRUNE_EVERY - 1).to_string()
        );
        let count: i64 = audit
            .conn
            .lock()
            .query_row("SELECT COUNT(*) FROM access_audit", [], |r| r.get(0))
            .unwrap();
        assert!(
            count <= AUDIT_KEEP + AUDIT_PRUNE_EVERY as i64,
            "bounded, got {count}"
        );
    }
}

#[cfg(test)]
mod config_tests {
    use super::*;

    #[test]
    fn roles_parse_from_toml_and_resolve_for_the_persona() {
        let toml = r#"
            [roles.qa]
            permissions = ["review", "memory.private.write"]

            [[personas]]
            id = "Tester"
            roles = ["qa"]
            permissions = ["integrate"]
        "#;
        let config: HivemindConfig = toml::from_str(toml).unwrap();
        validate(&config).unwrap();
        let grants = resolve(&config.agents[0], &config.roles);
        assert_eq!(
            grants.permissions,
            ["integrate", "memory.private.write", "review", "task.decide"]
        );
        assert!(grants.restricted);
    }
}
