use std::path::Path;

use anyhow::Result;
use hivemind::{
    access::{AuditEntry, AuditFilter},
    config::HivemindConfig,
    core::HivemindCore,
};

use super::args::AccessCommand;

fn print_entry(entry: &AuditEntry) {
    let permission = if entry.permission.is_empty() {
        "-"
    } else {
        entry.permission.as_str()
    };
    println!(
        "{:>6} {} {:<5} {} {} {} — {}",
        entry.id,
        entry.at,
        if entry.allowed { "allow" } else { "DENY" },
        entry.persona,
        entry.action,
        permission,
        entry.reason
    );
}

pub(super) async fn access_command(
    config: HivemindConfig,
    config_path: &Path,
    command: AccessCommand,
) -> Result<()> {
    let core = HivemindCore::new(config, config_path)?;
    let result = match command {
        AccessCommand::Show => {
            for (persona, grants) in core.access().all() {
                let roles = if grants.roles.is_empty() {
                    "-".to_owned()
                } else {
                    grants.roles.join(", ")
                };
                let permissions = if grants.permissions.is_empty() {
                    "-".to_owned()
                } else {
                    grants.permissions.join(", ")
                };
                let memory = if grants.restricted {
                    "gated by roles"
                } else {
                    "unrestricted (no roles)"
                };
                println!("{persona}\n  roles: {roles}\n  permissions: {permissions}\n  memory writes: {memory}");
            }
            Ok(())
        }
        AccessCommand::Audit {
            limit,
            persona,
            denied,
        } => {
            let entries = core.access().audit().list(&AuditFilter {
                persona,
                denied_only: denied,
                limit,
            })?;
            if entries.is_empty() {
                println!("No matching audit entries.");
            }
            entries.iter().for_each(print_entry);
            Ok(())
        }
    };
    core.shutdown().await;
    result
}
