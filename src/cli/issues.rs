//! Inspect the backlog and run one council in the foreground.
use std::path::Path;

use anyhow::{Context, Result};
use hivemind::{
    config::HivemindConfig,
    core::HivemindCore,
    issues::{resolve_members, start_council, IssueKind, IssueStatus, Trigger},
};

use super::args::IssueCommand;

pub(super) async fn issue_command(
    config: HivemindConfig,
    config_path: &Path,
    command: IssueCommand,
) -> Result<()> {
    let core = HivemindCore::new(config, config_path)?;
    let result = dispatch(&core, command).await;
    core.shutdown().await;
    result
}

async fn dispatch(core: &HivemindCore, command: IssueCommand) -> Result<()> {
    let settings = core.issues().config();
    match command {
        IssueCommand::List { status, kind } => {
            let who = match resolve_members(&core.config()) {
                Ok(names) => names.join(", "),
                Err(error) => error.to_string(),
            };
            println!(
                "Issue council: {}{}  attendees: {}  prompt: {}",
                if settings.enabled {
                    settings.mode.as_str()
                } else {
                    "off"
                },
                if settings.enabled {
                    format!(
                        ", every {}s{}",
                        settings.interval_secs,
                        if settings.mode.as_str() == "automatic" {
                            format!(", after {}s quiet", settings.idle_secs)
                        } else {
                            String::new()
                        }
                    )
                } else {
                    String::new()
                },
                who,
                if settings.prompt.is_some() {
                    "custom"
                } else {
                    "default"
                }
            );
            let status = match status.as_deref() {
                None => Some(IssueStatus::Open),
                Some("all") => None,
                Some(value) => Some(
                    IssueStatus::parse(value)
                        .with_context(|| format!("unknown status '{value}'"))?,
                ),
            };
            let kind = kind
                .as_deref()
                .map(|value| {
                    IssueKind::parse(value).with_context(|| format!("unknown kind '{value}'"))
                })
                .transpose()?;
            for issue in core.issues().list(status, kind)? {
                println!(
                    "{}  {:<10} {:<12} {:<6} {}  ({})",
                    issue.id,
                    issue.status.as_str(),
                    issue.kind.as_str(),
                    issue.priority.as_str(),
                    issue.title,
                    issue.proposed_by
                );
            }
            Ok(())
        }
        IssueCommand::Show { id } => {
            let issue = core.issues().get(&id)?;
            println!("{} [{}] {}", issue.id, issue.kind.as_str(), issue.title);
            println!(
                "  status: {}  priority: {}  by: {}  round: {}",
                issue.status.as_str(),
                issue.priority.as_str(),
                issue.proposed_by,
                issue.round_id
            );
            if let Some(reason) = &issue.dismiss_reason {
                println!("  dismissed: {reason}");
            }
            println!();
            println!("{}", issue.body);
            Ok(())
        }
        IssueCommand::Dismiss { id, reason } => {
            let issue = core.issues().dismiss(&id, reason)?;
            println!("Dismissed {} ({})", issue.id, issue.title);
            Ok(())
        }
        IssueCommand::Run => {
            if !settings.enabled {
                anyhow::bail!("issue council is disabled; set [issues] enabled = true");
            }
            let interrupted = core.issues().interrupt_running()?;
            if interrupted > 0 {
                println!("Interrupted {interrupted} unfinished council(s).");
            }
            println!("Starting an issue council. Filed issues are not implemented.");
            start_council(core, Trigger::Manual, None).await?;
            let latest = core
                .issues()
                .rounds(1)?
                .into_iter()
                .next()
                .context("council finished without a round record")?;
            println!(
                "Council {} {}: {} issue(s).",
                latest.id,
                latest.status.as_str(),
                latest.issue_count
            );
            if let Some(error) = &latest.error {
                println!("  {error}");
            }
            Ok(())
        }
    }
}
