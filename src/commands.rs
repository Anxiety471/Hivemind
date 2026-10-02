use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::atomic::{AtomicUsize, Ordering},
};

use anyhow::{anyhow, bail, Context, Result};

use crate::config::{AgentConfig, GroupConfig, HivemindConfig};

static NEXT_CONFIG_TEMP: AtomicUsize = AtomicUsize::new(0);

pub fn agent<'a>(config: &'a HivemindConfig, name: &str) -> Result<&'a AgentConfig> {
    config
        .agents
        .iter()
        .find(|agent| agent.name == name)
        .ok_or_else(|| anyhow!("no configured agent named '{name}'"))
}

pub fn group<'a>(config: &'a HivemindConfig, name: &str) -> Result<&'a GroupConfig> {
    config
        .groups
        .iter()
        .find(|group| group.name == name)
        .ok_or_else(|| anyhow!("no group named '{name}'"))
}

pub fn ordered_group_members<'a>(
    config: &'a HivemindConfig,
    name: &str,
) -> Result<Vec<&'a AgentConfig>> {
    let group = group(config, name)?;
    Ok(config.ordered_group_members(group))
}

/// Apply one group operation and persist it before exposing the new state.
pub fn mutate_group(config: &mut HivemindConfig, path: &Path, command: GroupCommand) -> Result<()> {
    let mut staged = config.clone();
    sync_group_workspaces(&mut staged, path)?;
    apply_group_mutation(&mut staged, command)?;
    persist_groups(&staged, path)?;
    *config = staged;
    Ok(())
}

/// Agents can record a group's shared workspace in the file while a shell holds an
/// older copy; the file is authoritative so a group edit never reverts it.
fn sync_group_workspaces(config: &mut HivemindConfig, path: &Path) -> Result<()> {
    let path_str = path.to_str().context("invalid config path")?;
    if path_str.contains("..") {
        bail!("invalid config path");
    }
    let raw = fs::read_to_string(path_str)
        .with_context(|| format!("reading config {}", path.display()))?;
    let disk: HivemindConfig =
        toml::from_str(&raw).with_context(|| format!("parsing config {}", path.display()))?;
    for group in &mut config.groups {
        if let Some(on_disk) = disk.groups.iter().find(|g| g.name == group.name) {
            group.workspace = on_disk.workspace.clone();
        }
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct GroupDocument<'a> {
    groups: &'a [GroupConfig],
}

fn persist_groups(config: &HivemindConfig, path: &Path) -> Result<()> {
    let path_str = path.to_str().context("invalid config path")?;
    if path_str.contains("..") {
        bail!("invalid config path");
    }
    let raw = fs::read_to_string(path_str)
        .with_context(|| format!("reading config {}", path.display()))?;
    let mut document = raw
        .parse::<toml_edit::DocumentMut>()
        .with_context(|| format!("parsing config {}", path.display()))?;
    let groups = toml::to_string(&GroupDocument {
        groups: &config.groups,
    })?
    .parse::<toml_edit::DocumentMut>()
    .context("serializing group configuration")?;
    document["groups"] = groups["groups"].clone();
    let updated = document.to_string();
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let file_name = path.file_name().context("config path has no filename")?;
    let permissions = fs::metadata(path_str)
        .with_context(|| format!("reading config metadata {}", path.display()))?
        .permissions();
    let (temp, mut file) = loop {
        let temp = parent.join(format!(
            ".{}.groups.{}.{}.tmp",
            file_name.to_string_lossy(),
            std::process::id(),
            NEXT_CONFIG_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let temp_str = temp.to_str().context("invalid temp path")?;
        if temp_str.contains("..") {
            bail!("invalid temp path");
        }
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temp_str)
        {
            Ok(file) => break (temp, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("creating temp config {}", temp.display()))
            }
        }
    };
    let write_result = (|| {
        file.write_all(updated.as_bytes())?;
        file.set_permissions(permissions)?;
        file.sync_all()
    })();
    drop(file);
    let temp_str = temp.to_str().context("invalid temp path")?;
    if temp_str.contains("..") {
        bail!("invalid temp path");
    }
    let result = write_result.and_then(|()| fs::rename(temp_str, path_str));
    if result.is_err() {
        let _ = fs::remove_file(temp_str);
    }
    result.with_context(|| format!("persisting config {}", path.display()))
}

fn apply_group_mutation(config: &mut HivemindConfig, command: GroupCommand) -> Result<()> {
    match command {
        GroupCommand::Create { name, agents } => {
            valid_name(&name)?;
            if name == "main" {
                bail!("group name 'main' is reserved");
            }
            if config.groups.iter().any(|group| group.name == name) {
                bail!("group '{name}' already exists");
            }

            let mut seen = HashSet::with_capacity(agents.len());
            for member in &agents {
                agent(config, member)?;
                if !seen.insert(member) {
                    bail!("group '{name}' contains duplicate members");
                }
            }

            config.groups.push(GroupConfig {
                name,
                members: agents,
                mode: Default::default(),
                member_roles: Default::default(),
                reply_order: Default::default(),
                workspace: None,
            });
        }
        GroupCommand::Update {
            name,
            members,
            mode,
            member_roles,
            reply_order,
        } => {
            if let Some(members) = &members {
                let mut seen = HashSet::with_capacity(members.len());
                for member in members {
                    agent(config, member)?;
                    if !seen.insert(member) {
                        bail!("group '{name}' contains duplicate members");
                    }
                }
            }
            let group = find_group_mut(config, &name)?;
            if let Some(members) = members {
                group.members = members;
            }
            if let Some(mode) = mode {
                group.mode = mode;
            }
            if let Some(roles) = member_roles {
                group.member_roles = roles;
            }
            if let Some(order) = reply_order {
                group.reply_order = order;
            }
            // Keep metadata consistent with the member list.
            let members = group.members.clone();
            group
                .member_roles
                .retain(|member, _| members.contains(member));
            if let Some(unknown) = group.reply_order.iter().find(|m| !members.contains(m)) {
                bail!("reply order names '{unknown}', who is not in group '{name}'");
            }
        }
        GroupCommand::Add {
            name,
            agent: member,
        } => {
            agent(config, &member)?;
            let group = find_group_mut(config, &name)?;
            if group.members.contains(&member) {
                bail!("agent '{member}' is already in group '{name}'");
            }
            group.members.push(member);
        }
        GroupCommand::Remove {
            name,
            agent: member,
        } => {
            let group = find_group_mut(config, &name)?;
            let Some(index) = group.members.iter().position(|agent| agent == &member) else {
                bail!("agent '{member}' is not in group '{name}'");
            };
            group.members.remove(index);
            group.member_roles.remove(&member);
            group.reply_order.retain(|name| name != &member);
        }
        GroupCommand::Delete { name } => {
            let Some(index) = config.groups.iter().position(|group| group.name == name) else {
                bail!("no group named '{name}'");
            };
            config.groups.remove(index);
        }
    }

    Ok(())
}

fn find_group_mut<'a>(config: &'a mut HivemindConfig, name: &str) -> Result<&'a mut GroupConfig> {
    config
        .groups
        .iter_mut()
        .find(|group| group.name == name)
        .ok_or_else(|| anyhow!("no group named '{name}'"))
}

fn valid_name(name: &str) -> Result<()> {
    if name.trim().is_empty() || name.contains("..") || name.contains('/') || name.contains('\\') {
        bail!("group name cannot be empty or contain '..', '/', or '\\'");
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupCommand {
    Create {
        name: String,
        agents: Vec<String>,
    },
    /// Replace any of a group's members, mode, member roles, or reply order; `None` keeps it.
    Update {
        name: String,
        members: Option<Vec<String>>,
        mode: Option<crate::config::ConversationMode>,
        member_roles: Option<std::collections::HashMap<String, String>>,
        reply_order: Option<Vec<String>>,
    },
    Add {
        name: String,
        agent: String,
    },
    Remove {
        name: String,
        agent: String,
    },
    Delete {
        name: String,
    },
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use super::*;
    use crate::config::HivemindConfig;

    static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "hivemind-groups-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn config_path(&self) -> PathBuf {
            self.0.join("config.toml")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn group_mutations_persist_and_enforce_membership_rules() {
        let fixture = Fixture::new();
        let path = fixture.config_path();
        let mut config = HivemindConfig::default_poc();
        fs::write(&path, toml::to_string_pretty(&config).unwrap()).unwrap();

        mutate_group(
            &mut config,
            &path,
            GroupCommand::Create {
                name: "backend".into(),
                agents: vec!["Reviewer".into()],
            },
        )
        .unwrap();
        assert_eq!(
            HivemindConfig::load(&path).unwrap().groups[0].members,
            ["Reviewer"]
        );

        assert!(mutate_group(
            &mut config,
            &path,
            GroupCommand::Add {
                name: "backend".into(),
                agent: "Reviewer".into(),
            },
        )
        .unwrap_err()
        .to_string()
        .contains("already in group"));

        mutate_group(
            &mut config,
            &path,
            GroupCommand::Remove {
                name: "backend".into(),
                agent: "Reviewer".into(),
            },
        )
        .unwrap();
        assert!(ordered_group_members(&config, "backend")
            .unwrap()
            .is_empty());
        assert!(HivemindConfig::load(&path).unwrap().groups[0]
            .members
            .is_empty());

        mutate_group(
            &mut config,
            &path,
            GroupCommand::Delete {
                name: "backend".into(),
            },
        )
        .unwrap();
        assert!(HivemindConfig::load(&path).unwrap().groups.is_empty());
    }

    #[test]
    fn group_mutation_preserves_unrelated_config_comments_and_formatting() {
        let fixture = Fixture::new();
        let path = fixture.config_path();
        let mut config = HivemindConfig::default_poc();
        fs::write(&path, toml::to_string_pretty(&config).unwrap()).unwrap();

        let raw = fs::read_to_string(&path)
            .unwrap()
            .replacen("[runtime]", "# keep runtime comment\n[runtime]", 1)
            .replacen(
                "pi_binary = \"pi\"",
                "pi_binary  = \"pi\" # keep runtime setting",
                1,
            );
        fs::write(&path, raw).unwrap();

        mutate_group(
            &mut config,
            &path,
            GroupCommand::Create {
                name: "backend".into(),
                agents: vec!["Reviewer".into()],
            },
        )
        .unwrap();

        let persisted = fs::read_to_string(&path).unwrap();
        assert!(persisted.contains("# keep runtime comment"));
        assert!(persisted.contains("pi_binary  = \"pi\" # keep runtime setting"));
        let reloaded = HivemindConfig::load(&path).unwrap();
        assert_eq!(reloaded.runtime.pi_binary, "pi");
        assert_eq!(reloaded.groups[0].members, ["Reviewer"]);
    }

    #[test]
    fn removing_group_member_cleans_role_and_reply_order_metadata() {
        let fixture = Fixture::new();
        let path = fixture.config_path();
        let mut config = HivemindConfig::default_poc();
        config.groups.push(GroupConfig {
            name: "backend".into(),
            members: vec!["Reviewer".into(), "Engineer".into()],
            mode: Default::default(),
            member_roles: [
                ("Reviewer".into(), "reviewer".into()),
                ("Engineer".into(), "implementer".into()),
            ]
            .into(),
            reply_order: vec!["Reviewer".into(), "Engineer".into()],
            workspace: None,
        });
        fs::write(&path, toml::to_string_pretty(&config).unwrap()).unwrap();

        mutate_group(
            &mut config,
            &path,
            GroupCommand::Remove {
                name: "backend".into(),
                agent: "Reviewer".into(),
            },
        )
        .unwrap();

        let reloaded = HivemindConfig::load(&path).unwrap();
        let group = &reloaded.groups[0];
        assert_eq!(group.members, ["Engineer"]);
        assert!(!group.member_roles.contains_key("Reviewer"));
        assert_eq!(
            group.member_roles.get("Engineer").map(String::as_str),
            Some("implementer")
        );
        assert_eq!(group.reply_order, ["Engineer"]);
    }

    #[test]
    fn invalid_mutations_and_failed_writes_leave_live_config_unchanged() {
        let fixture = Fixture::new();
        let path = fixture.config_path();
        let mut config = HivemindConfig::default_poc();
        let original_groups = config.groups.clone();

        for agents in [
            vec!["Missing".to_string()],
            vec!["Reviewer".to_string(), "Reviewer".to_string()],
        ] {
            assert!(mutate_group(
                &mut config,
                &path,
                GroupCommand::Create {
                    name: "backend".into(),
                    agents,
                },
            )
            .is_err());
            assert_eq!(config.groups, original_groups);
        }

        let invalid_path = fixture.0.join("missing").join("config.toml");
        assert!(mutate_group(
            &mut config,
            &invalid_path,
            GroupCommand::Create {
                name: "backend".into(),
                agents: vec!["Reviewer".into()],
            },
        )
        .is_err());
        assert_eq!(config.groups, original_groups);
    }

    #[test]
    fn group_creation_rejects_reserved_and_duplicate_names_but_allows_empty_groups() {
        let fixture = Fixture::new();
        let path = fixture.config_path();
        let mut config = HivemindConfig::default_poc();
        fs::write(&path, toml::to_string_pretty(&config).unwrap()).unwrap();

        for name in ["main", " "] {
            assert!(mutate_group(
                &mut config,
                &path,
                GroupCommand::Create {
                    name: name.into(),
                    agents: vec![],
                },
            )
            .is_err());
        }

        let create_empty = GroupCommand::Create {
            name: "empty".into(),
            agents: vec![],
        };
        mutate_group(&mut config, &path, create_empty.clone()).unwrap();
        assert!(ordered_group_members(&config, "empty").unwrap().is_empty());
        assert!(mutate_group(&mut config, &path, create_empty)
            .unwrap_err()
            .to_string()
            .contains("already exists"));
        assert_eq!(HivemindConfig::load(&path).unwrap().groups[0].name, "empty");
    }

    use std::path::PathBuf;
}
