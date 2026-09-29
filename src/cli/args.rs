use std::path::PathBuf;

use clap::{Parser, Subcommand};
#[derive(Debug, Parser)]
#[command(
    name = "hivemind",
    version,
    about = "Runtime-agnostic meta-harness for AI agents"
)]
pub(super) struct Cli {
    #[arg(long, global = true, default_value = "hivemind.toml")]
    pub(super) config: PathBuf,
    #[command(subcommand)]
    pub(super) command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
pub(super) enum Commands {
    /// Create a starter Hivemind configuration.
    Init {
        /// Replace an existing config file.
        #[arg(long)]
        force: bool,
    },
    /// Check local configuration and runtime executables.
    Doctor,
    /// Start an interactive conversation.
    Chat {
        #[arg(long, conflicts_with = "group")]
        solo: Option<String>,
        #[arg(long)]
        group: Option<String>,
    },
    /// List configured agents.
    Agents,
    /// Show local configuration and runtime readiness.
    Status,
    /// Print effective reply order.
    Order,
    /// Prompt one agent once.
    Ask { agent: String, message: String },
    /// Prompt every configured agent once.
    All { message: String },
    /// Manage persisted conversation groups.
    Group {
        #[command(subcommand)]
        command: ShellGroupCommand,
    },
    /// Start the local HTTP and WebSocket API.
    Serve {
        #[arg(long, default_value_t = 7474)]
        port: u16,
    },
}

#[derive(Debug, Subcommand)]
pub(super) enum ShellGroupCommand {
    Create {
        name: String,
        #[arg(value_name = "AGENT")]
        agents: Vec<String>,
    },
    List,
    Show {
        name: String,
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
