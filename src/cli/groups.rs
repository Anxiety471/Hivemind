use std::fmt::Write as _;

use anyhow::Result;
use hivemind::{config::HivemindConfig, core::HivemindCore};

use super::args::ShellGroupCommand;
use crate::commands::{self, mutate_group, GroupCommand};

pub(super) fn mutate_group_and_reload(
    config: &mut HivemindConfig,
    path: &std::path::Path,
    core: Option<&HivemindCore>,
    command: GroupCommand,
) -> Result<()> {
    mutate_group(config, path, command)?;
    let updated = HivemindConfig::load(path)?;
    if let Some(core) = core {
        core.reload_groups(updated.groups.clone());
    }
    *config = updated;
    Ok(())
}

pub(super) fn group_command(
    config: &mut HivemindConfig,
    path: &std::path::Path,
    core: Option<&HivemindCore>,
    command: ShellGroupCommand,
) -> Result<()> {
    match command {
        ShellGroupCommand::Create { name, agents } => {
            mutate_group_and_reload(config, path, core, GroupCommand::Create { name, agents })
        }
        ShellGroupCommand::List => {
            println!("Groups:");
            for group in &config.groups {
                println!(
                    "  {:<12} {}",
                    group.name,
                    group_member_summary(config, &group.name)?
                );
            }
            Ok(())
        }
        ShellGroupCommand::Show { name } => {
            print!("{}", render_group(config, &name)?);
            Ok(())
        }
        ShellGroupCommand::Add { name, agent } => {
            mutate_group_and_reload(config, path, core, GroupCommand::Add { name, agent })
        }
        ShellGroupCommand::Remove { name, agent } => {
            mutate_group_and_reload(config, path, core, GroupCommand::Remove { name, agent })
        }
        ShellGroupCommand::Delete { name } => {
            mutate_group_and_reload(config, path, core, GroupCommand::Delete { name })
        }
    }
}

pub(super) fn group_member_summary(config: &HivemindConfig, name: &str) -> Result<String> {
    let members = commands::ordered_group_members(config, name)?;
    if members.is_empty() {
        return Ok("(no agents)".into());
    }
    let mut summary = String::new();
    for (index, member) in members.iter().enumerate() {
        if index > 0 {
            summary.push_str(", ");
        }
        summary.push_str(&member.name);
    }
    Ok(summary)
}

pub(super) fn render_group(config: &HivemindConfig, name: &str) -> Result<String> {
    let members = commands::ordered_group_members(config, name)?;
    let mut output = format!("Group: {name}\nMembers:\n");
    for (index, agent) in members.iter().enumerate() {
        writeln!(
            &mut output,
            "  {}. {} [{}]",
            index + 1,
            agent.name,
            agent.runtime
        )
        .expect("writing to a String cannot fail");
    }
    output.push_str("\nEffective reply order:\n");
    for (index, agent) in members.iter().enumerate() {
        writeln!(&mut output, "  {}. {}", index + 1, agent.name)
            .expect("writing to a String cannot fail");
    }
    Ok(output)
}
