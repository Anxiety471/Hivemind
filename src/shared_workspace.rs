//! Workspaces agents can read and change with tools.
//!
//! A group has a shared workspace only when the user configured one (`workspace`
//! under `[[groups]]`) or told an agent in chat, and the agent recorded it with
//! `workspace.set`. Without one, members keep their own persona workspaces and
//! are told not to assume a shared directory. A solo agent can read and change
//! its own persona workspace the same way. `[workspaces] roots` optionally limits
//! where agents may point; paths the user writes in the config are never checked.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

use anyhow::{bail, Context, Result};
use serde_json::Value;

use crate::{config::HivemindConfig, conversation::ToolHost};

const GROUP_ROOM_PREFIX: &str = "group-";
const SOLO_ROOM_PREFIX: &str = "solo-";
const MAX_PATH_BYTES: usize = 1024;
const MAX_LISTED: usize = 50;

#[derive(Default)]
struct State {
    /// Group id -> shared workspace (`None`: the group has none).
    groups: HashMap<String, Option<String>>,
    /// Persona id -> its own workspace.
    personas: HashMap<String, String>,
}

/// Runtime view of agent-changeable workspaces, backed by the config file so a
/// path an agent records survives restarts.
pub struct SharedWorkspaces {
    config_path: PathBuf,
    roots: Vec<String>,
    state: RwLock<State>,
}

impl SharedWorkspaces {
    pub fn new(config_path: &Path, config: &HivemindConfig) -> Self {
        let store = Self { config_path: config_path.to_owned(), roots: config.workspaces.roots.clone(), state: RwLock::new(State::default()) };
        store.replace_groups(&config.groups);
        store.state.write().expect("workspace lock poisoned").personas = config.agents.iter().map(|a| (a.name.clone(), a.workspace.clone())).collect();
        store
    }

    /// Re-sync after the group definitions changed.
    pub fn replace_groups(&self, groups: &[crate::config::GroupConfig]) {
        let next = groups.iter().map(|g| (g.name.clone(), g.workspace.clone())).collect();
        self.state.write().expect("workspace lock poisoned").groups = next;
    }

    /// The group's shared workspace; `None` when it has none configured.
    pub fn group(&self, group: &str) -> Option<String> {
        self.state.read().expect("workspace lock poisoned").groups.get(group).cloned().flatten()
    }

    /// The persona's own workspace as currently recorded.
    pub fn persona(&self, persona: &str) -> Option<String> {
        self.state.read().expect("workspace lock poisoned").personas.get(persona).cloned()
    }

    fn known_group(&self, group: &str) -> bool {
        self.state.read().expect("workspace lock poisoned").groups.contains_key(group)
    }

    fn known_persona(&self, persona: &str) -> bool {
        self.state.read().expect("workspace lock poisoned").personas.contains_key(persona)
    }

    /// Validate, persist to the config file, then expose the new workspace.
    pub fn set_group(&self, group: &str, path: &str) -> Result<String> {
        let workspace = self.validate(path)?;
        let mut state = self.state.write().expect("workspace lock poisoned");
        if !state.groups.contains_key(group) {
            bail!("unknown group '{group}'");
        }
        persist(&self.config_path, &["groups"], group, Some(&workspace))?;
        state.groups.insert(group.to_owned(), Some(workspace.clone()));
        Ok(workspace)
    }

    /// Remove a group's shared workspace so members go back to their own.
    pub fn clear_group(&self, group: &str) -> Result<()> {
        let mut state = self.state.write().expect("workspace lock poisoned");
        if !state.groups.contains_key(group) {
            bail!("unknown group '{group}'");
        }
        persist(&self.config_path, &["groups"], group, None)?;
        state.groups.insert(group.to_owned(), None);
        Ok(())
    }

    pub fn set_persona(&self, persona: &str, path: &str) -> Result<String> {
        let workspace = self.validate(path)?;
        let mut state = self.state.write().expect("workspace lock poisoned");
        if !state.personas.contains_key(persona) {
            bail!("unknown persona '{persona}'");
        }
        persist(&self.config_path, &["personas", "agents"], persona, Some(&workspace))?;
        state.personas.insert(persona.to_owned(), workspace.clone());
        Ok(workspace)
    }

    /// Directories agents may choose: each configured root and its visible subdirectories.
    pub fn list(&self) -> Result<String> {
        if self.roots.is_empty() {
            return Ok("No workspace roots are configured, so there is no list to choose from. Any existing absolute directory the user names is accepted.".into());
        }
        let mut found = Vec::new();
        for root in &self.roots {
            found.push(root.clone());
            let Ok(entries) = fs::read_dir(root) else { continue };
            let mut children: Vec<String> = entries
                .flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && !e.file_name().to_string_lossy().starts_with('.'))
                .map(|e| e.path().display().to_string())
                .collect();
            children.sort();
            found.extend(children);
        }
        let total = found.len();
        found.truncate(MAX_LISTED);
        let mut out = found.iter().map(|p| format!("- {p}")).collect::<Vec<_>>().join("\n");
        if total > MAX_LISTED {
            out.push_str(&format!("\n({} more not shown)", total - MAX_LISTED));
        }
        Ok(out)
    }

    fn validate(&self, path: &str) -> Result<String> {
        let trimmed = path.trim();
        if trimmed.is_empty() || trimmed.len() > MAX_PATH_BYTES {
            bail!("path must be 1-{MAX_PATH_BYTES} bytes");
        }
        if !Path::new(trimmed).is_absolute() {
            bail!("path must be absolute, got '{trimmed}'");
        }
        let real = fs::canonicalize(trimmed).ok().filter(|p| p.is_dir()).with_context(|| format!("'{trimmed}' does not exist or is not a directory"))?;
        if !self.roots.is_empty() && !self.roots.iter().any(|root| fs::canonicalize(root).is_ok_and(|root| real.starts_with(root))) {
            bail!("'{trimmed}' is outside the allowed workspace roots [{}]; use workspace.list to see the choices", self.roots.join(", "));
        }
        Ok(crate::coordination::policy::normalize_workspace(trimmed))
    }
}

/// Set (or with `None`, remove) `workspace` on the table whose `id`/`name` is `id`
/// under the first present section, touching nothing else in the file.
fn persist(config: &Path, sections: &[&str], id: &str, workspace: Option<&str>) -> Result<()> {
    let raw = fs::read_to_string(config).with_context(|| format!("reading config {}", config.display()))?;
    let mut document = raw.parse::<toml_edit::DocumentMut>().with_context(|| format!("parsing config {}", config.display()))?;
    let matches = |t: &toml_edit::Table| ["id", "name"].iter().any(|key| t.get(key).and_then(toml_edit::Item::as_str) == Some(id));
    let section = sections
        .iter()
        .find(|section| document.get(section).and_then(toml_edit::Item::as_array_of_tables).is_some_and(|tables| tables.iter().any(matches)))
        .with_context(|| format!("'{id}' is not in {}", config.display()))?;
    let table = document[section].as_array_of_tables_mut().and_then(|tables| tables.iter_mut().find(|t| matches(t))).context("table vanished")?;
    match workspace {
        Some(workspace) => table["workspace"] = toml_edit::value(workspace),
        None => {
            table.remove("workspace");
        }
    }
    let parent = config.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let temp = parent.join(format!(".{}.workspace.{}.tmp", config.file_name().context("config path has no filename")?.to_string_lossy(), std::process::id()));
    let permissions = fs::metadata(config)?.permissions();
    let write = fs::write(&temp, document.to_string()).and_then(|()| fs::set_permissions(&temp, permissions)).and_then(|()| fs::rename(&temp, config));
    if write.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write.with_context(|| format!("persisting config {}", config.display()))
}

enum Scope<'a> {
    Group(&'a str),
    Solo(&'a str),
}

/// Agent tools `workspace.get|set|list` (plus `clear` for groups), offered only in
/// group rooms and solo rooms.
pub struct WorkspaceTools {
    workspaces: Arc<SharedWorkspaces>,
}

impl WorkspaceTools {
    pub fn new(workspaces: Arc<SharedWorkspaces>) -> Self {
        Self { workspaces }
    }

    fn scope<'a>(&self, room: &'a str) -> Option<Scope<'a>> {
        if let Some(group) = room.strip_prefix(GROUP_ROOM_PREFIX).filter(|g| self.workspaces.known_group(g)) {
            return Some(Scope::Group(group));
        }
        room.strip_prefix(SOLO_ROOM_PREFIX).filter(|p| self.workspaces.known_persona(p)).map(Scope::Solo)
    }

    fn state_line(&self, scope: &Scope) -> String {
        match scope {
            Scope::Group(group) => match self.workspaces.group(group) {
                Some(path) => format!("Shared workspace: {path} (every member of this group works there)."),
                None => "Shared workspace: not configured. Do not assume one; each member keeps its own workspace.".into(),
            },
            Scope::Solo(persona) => format!("Your workspace: {}.", self.workspaces.persona(persona).unwrap_or_default()),
        }
    }
}

impl ToolHost for WorkspaceTools {
    fn manifest(&self, room: &str, _persona: &str) -> Option<String> {
        let scope = self.scope(room)?;
        let (tools, effect) = match scope {
            Scope::Group(_) => (
                "workspace.get() · workspace.set(path) · workspace.clear() · workspace.list()",
                "If the user tells you where the group's shared workspace is, or asks you to change it, call workspace.set; that adds or updates it for the whole group. workspace.clear removes it so members go back to their own workspaces.",
            ),
            Scope::Solo(_) => (
                "workspace.get() · workspace.set(path) · workspace.list()",
                "If the user tells you where you should work or asks you to change it, call workspace.set. That changes your own workspace everywhere you are used, not just this chat.",
            ),
        };
        Some(format!(
            "\nHivemind workspace tools (same ```hivemind-tool fence; one call per reply as your whole reply): {tools}\n{}\n{effect} Paths must be absolute, existing directories, and may be limited to configured roots (workspace.list shows them). A change takes effect from the next message. Never invent a path the user did not give.\n",
            self.state_line(&scope)
        ))
    }

    fn reminder(&self, room: &str, _persona: &str) -> Option<String> {
        let scope = self.scope(room)?;
        Some(format!("{} workspace.* tools remain available.\n", self.state_line(&scope)))
    }

    fn handles(&self, name: &str) -> bool {
        matches!(name, "workspace.get" | "workspace.set" | "workspace.clear" | "workspace.list")
    }

    fn execute(&self, room: &str, _persona: &str, name: &str, args: &Value) -> Result<String> {
        let scope = self.scope(room).context("workspace tools are only available in group and solo rooms")?;
        let path = || args.get("path").and_then(Value::as_str).context("tool argument 'path' must be a non-empty string");
        match (name, &scope) {
            ("workspace.get", _) => Ok(self.state_line(&scope)),
            ("workspace.list", _) => self.workspaces.list(),
            ("workspace.set", Scope::Group(group)) => {
                let workspace = self.workspaces.set_group(group, path()?)?;
                Ok(format!("Shared workspace set to {workspace}. Every member uses it from the next message."))
            }
            ("workspace.set", Scope::Solo(persona)) => {
                let workspace = self.workspaces.set_persona(persona, path()?)?;
                Ok(format!("Your workspace is now {workspace}. It applies from the next message."))
            }
            ("workspace.clear", Scope::Group(group)) => {
                self.workspaces.clear_group(group)?;
                Ok("Shared workspace cleared. Members use their own workspaces from the next message.".into())
            }
            ("workspace.clear", Scope::Solo(_)) => bail!("a solo agent always has its own workspace; use workspace.set to change it"),
            (other, _) => bail!("unknown workspace tool '{other}'"),
        }
    }
}

/// Several tool hosts behind the coordinator's single host slot.
pub struct ToolHosts(pub Vec<Arc<dyn ToolHost>>);

impl ToolHost for ToolHosts {
    fn manifest(&self, room: &str, persona: &str) -> Option<String> {
        let parts: Vec<String> = self.0.iter().filter_map(|h| h.manifest(room, persona)).collect();
        (!parts.is_empty()).then(|| parts.concat())
    }

    fn reminder(&self, room: &str, persona: &str) -> Option<String> {
        let parts: Vec<String> = self.0.iter().filter_map(|h| h.reminder(room, persona)).collect();
        (!parts.is_empty()).then(|| parts.concat())
    }

    fn max_actions(&self, room: &str) -> usize {
        self.0.iter().map(|h| h.max_actions(room)).max().unwrap_or(0)
    }

    fn agent_originated(&self, room: &str) -> bool {
        self.0.iter().any(|h| h.agent_originated(room))
    }

    fn handles(&self, name: &str) -> bool {
        self.0.iter().any(|h| h.handles(name))
    }

    fn execute(&self, room: &str, persona: &str, name: &str, args: &Value) -> Result<String> {
        self.0.iter().find(|h| h.handles(name)).with_context(|| format!("no tool host handles '{name}'"))?.execute(room, persona, name, args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::{GroupConfig, HivemindConfig}, core::{ConversationTarget, HivemindCore}};
    use serde_json::json;

    struct Dir(PathBuf);
    impl Dir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!("hivemind-shared-ws-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(path.join("project")).unwrap();
            Self(path)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn core_with_group(dir: &Dir, workspace: Option<&str>) -> HivemindCore {
        core_with_roots(dir, workspace, &[])
    }

    fn core_with_roots(dir: &Dir, workspace: Option<&str>, roots: &[String]) -> HivemindCore {
        let mut config = HivemindConfig::default_poc();
        config.workspaces.roots = roots.to_vec();
        for agent in &mut config.agents {
            agent.workspace = dir.0.display().to_string();
        }
        config.groups.push(GroupConfig {
            name: "team".into(),
            members: config.agents.iter().map(|a| a.name.clone()).collect(),
            mode: Default::default(),
            member_roles: Default::default(),
            reply_order: Vec::new(),
            workspace: workspace.map(str::to_owned),
        });
        let path = dir.0.join("hivemind.toml");
        fs::write(&path, toml::to_string_pretty(&config).unwrap()).unwrap();
        HivemindCore::new(config, path).unwrap()
    }

    fn workspaces_of(core: &HivemindCore) -> Vec<String> {
        let target = core.resolve_target(&ConversationTarget::Group { group_id: "team".into() }).unwrap();
        target.participants.iter().map(|p| p.agent.workspace.clone()).collect()
    }

    #[test]
    fn unconfigured_group_keeps_persona_workspaces_until_an_agent_sets_one() {
        let dir = Dir::new("set");
        let core = core_with_group(&dir, None);
        let own = dir.0.display().to_string();
        assert!(workspaces_of(&core).iter().all(|w| *w == own));

        let tools = WorkspaceTools::new(core.shared_workspaces().clone());
        let manifest = tools.manifest("group-team", "Engineer").unwrap();
        assert!(manifest.contains("not configured"), "{manifest}");
        assert!(tools.manifest("main", "Engineer").is_none());

        let project = dir.0.join("project").display().to_string();
        let reply = tools.execute("group-team", "Engineer", "workspace.set", &json!({"path": project})).unwrap();
        assert!(reply.contains(&project));
        assert!(workspaces_of(&core).iter().all(|w| *w == project), "every member moves to the shared workspace");
        assert!(tools.execute("group-team", "Reviewer", "workspace.get", &json!({})).unwrap().contains(&project));
        assert!(tools.manifest("group-team", "Reviewer").unwrap().contains(&project));

        // Persisted: a fresh load sees it, and unrelated config is untouched.
        let reloaded = HivemindConfig::load(&dir.0.join("hivemind.toml")).unwrap();
        assert_eq!(reloaded.groups[0].workspace.as_deref(), Some(project.as_str()));
        assert_eq!(reloaded.agents.len(), 2);
    }

    #[test]
    fn configured_workspace_applies_and_bad_paths_are_rejected() {
        let dir = Dir::new("cfg");
        let project = dir.0.join("project").display().to_string();
        let core = core_with_group(&dir, Some(&project));
        assert!(workspaces_of(&core).iter().all(|w| *w == project));

        let tools = WorkspaceTools::new(core.shared_workspaces().clone());
        for bad in [json!({"path": "relative/dir"}), json!({"path": "/no/such/dir/anywhere"}), json!({"path": "  "}), json!({})] {
            assert!(tools.execute("group-team", "Engineer", "workspace.set", &bad).is_err(), "{bad}");
        }
        assert!(tools.execute("group-team", "Engineer", "workspace.set", &json!({"path": dir.0.display().to_string()})).is_ok());
        assert!(workspaces_of(&core).iter().all(|w| *w == dir.0.display().to_string()), "set updates an existing workspace");
        assert!(tools.execute("main", "Engineer", "workspace.set", &json!({"path": project})).is_err(), "no tools in the main room");
    }

    #[test]
    fn clear_returns_members_to_their_own_workspaces_and_persists() {
        let dir = Dir::new("clear");
        let project = dir.0.join("project").display().to_string();
        let core = core_with_group(&dir, Some(&project));
        let tools = WorkspaceTools::new(core.shared_workspaces().clone());
        tools.execute("group-team", "Engineer", "workspace.clear", &json!({})).unwrap();
        let own = dir.0.display().to_string();
        assert!(workspaces_of(&core).iter().all(|w| *w == own));
        assert!(tools.manifest("group-team", "Engineer").unwrap().contains("not configured"));
        assert_eq!(HivemindConfig::load(&dir.0.join("hivemind.toml")).unwrap().groups[0].workspace, None);
    }

    #[test]
    fn roots_limit_what_agents_may_choose_and_list_shows_them() {
        let dir = Dir::new("roots");
        fs::create_dir_all(dir.0.join("allowed/alpha")).unwrap();
        fs::create_dir_all(dir.0.join("allowed/.hidden")).unwrap();
        fs::create_dir_all(dir.0.join("elsewhere")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.0.join("elsewhere"), dir.0.join("allowed/escape")).unwrap();
        let root = dir.0.join("allowed").display().to_string();
        let core = core_with_roots(&dir, None, std::slice::from_ref(&root));
        let tools = WorkspaceTools::new(core.shared_workspaces().clone());
        let listed = tools.execute("group-team", "Engineer", "workspace.list", &json!({})).unwrap();
        assert!(listed.contains(&format!("{root}/alpha")) && !listed.contains(".hidden"), "{listed}");
        let set = |path: &str| tools.execute("group-team", "Engineer", "workspace.set", &json!({"path": path}));
        assert!(set(&format!("{root}/alpha")).is_ok());
        assert!(set(&root).is_ok(), "the root itself is allowed");
        assert!(set(&dir.0.join("elsewhere").display().to_string()).unwrap_err().to_string().contains("outside"));
        #[cfg(unix)]
        assert!(set(&format!("{root}/escape")).is_err(), "a symlink out of the root is not a way around it");
        // Without roots there is nothing to list.
        let open = core_with_group(&Dir::new("noroots"), None);
        let open_tools = WorkspaceTools::new(open.shared_workspaces().clone());
        assert!(open_tools.execute("group-team", "Engineer", "workspace.list", &json!({})).unwrap().contains("No workspace roots"));
    }

    #[test]
    fn solo_agent_changes_its_own_workspace_for_every_room() {
        let dir = Dir::new("solo");
        let core = core_with_group(&dir, None);
        let tools = WorkspaceTools::new(core.shared_workspaces().clone());
        let manifest = tools.manifest("solo-Engineer", "Engineer").unwrap();
        assert!(manifest.contains("workspace.set") && !manifest.contains("workspace.clear"), "{manifest}");
        assert!(tools.manifest("solo-Ghost", "Ghost").is_none());
        let project = dir.0.join("project").display().to_string();
        tools.execute("solo-Engineer", "Engineer", "workspace.set", &json!({"path": project})).unwrap();
        let solo = core.resolve_target(&ConversationTarget::Solo { persona_id: "Engineer".into() }).unwrap();
        assert_eq!(solo.participants[0].agent.workspace, project);
        let main = core.resolve_target(&ConversationTarget::Main).unwrap();
        let engineer = main.participants.iter().find(|p| p.agent.name == "Engineer").unwrap();
        let reviewer = main.participants.iter().find(|p| p.agent.name == "Reviewer").unwrap();
        assert_eq!(engineer.agent.workspace, project);
        assert_ne!(reviewer.agent.workspace, project, "only that persona moved");
        assert!(tools.execute("solo-Engineer", "Engineer", "workspace.clear", &json!({})).is_err());
        assert!(tools.execute("solo-Engineer", "Engineer", "workspace.get", &json!({})).unwrap().contains(&project));
        let saved = HivemindConfig::load(&dir.0.join("hivemind.toml")).unwrap();
        assert_eq!(saved.agents.iter().find(|a| a.name == "Engineer").unwrap().workspace, project);
        // A shared group workspace still wins over the persona's own inside that group.
        let shared = dir.0.display().to_string();
        tools.execute("group-team", "Engineer", "workspace.set", &json!({"path": shared})).unwrap();
        assert!(workspaces_of(&core).iter().all(|w| *w == shared));
    }

    struct Script {
        replies: parking_lot::Mutex<std::collections::VecDeque<String>>,
        seen: parking_lot::Mutex<Vec<(String, String)>>,
    }
    #[async_trait::async_trait]
    impl crate::conversation::AgentInvoker for Script {
        async fn cursor(&self, _instance: &crate::identity::AgentInstanceId) -> Option<crate::runtime::SessionCursor> {
            None
        }
        async fn invoke(&self, request: crate::runtime::InvokeRequest<'_>) -> Result<crate::runtime::InvokeReply> {
            self.seen.lock().push((request.agent.workspace.clone(), request.full.to_owned()));
            let text = self.replies.lock().pop_front().unwrap_or_else(|| "done".into());
            Ok(crate::runtime::InvokeReply { text, epoch_id: "fake".into() })
        }
    }

    #[tokio::test]
    async fn agent_told_the_workspace_in_chat_records_it_for_the_next_turn() {
        let dir = Dir::new("chat");
        let core = core_with_group(&dir, None);
        let project = dir.0.join("project").display().to_string();
        let call = format!("```hivemind-tool\n{{\"name\":\"workspace.set\",\"args\":{{\"path\":\"{project}\"}}}}\n```\n");
        let script = Arc::new(Script { replies: parking_lot::Mutex::new([call].into()), seen: Default::default() });
        let target = ConversationTarget::Group { group_id: "team".into() };
        let resolved = core.resolve_target(&target).unwrap();
        core.send_resolved_turn(&resolved, &format!("our workspace is {project}"), script.clone()).await.unwrap();
        {
            let seen = script.seen.lock();
            assert!(seen[0].1.contains("workspace.set") && seen[0].1.contains("not configured"), "first pack advertises the tool and the missing workspace");
            assert!(seen[1].1.contains("Shared workspace set to"), "tool result reaches the agent");
        }
        script.seen.lock().clear();
        let resolved = core.resolve_target(&target).unwrap();
        core.send_resolved_turn(&resolved, "next", script.clone()).await.unwrap();
        let seen = script.seen.lock();
        assert!(seen.iter().all(|(workspace, _)| *workspace == project), "the next turn runs in the shared workspace");
        assert!(seen[0].1.contains(&format!("Shared workspace: {project}")));
    }
}
