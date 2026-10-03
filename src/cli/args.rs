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
    /// Check for and install the latest GitHub release.
    Update {
        /// Only report whether a newer release exists.
        #[arg(long)]
        check: bool,
    },
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
    /// Start the HTTP and WebSocket API (loopback by default).
    Serve {
        #[arg(long, default_value_t = 7474)]
        port: u16,
    },
    /// Submit and track autonomous coordination tasks.
    Task {
        #[command(subcommand)]
        command: TaskCommand,
    },
    /// Discuss and file the next features, improvements, and bug fixes.
    Issue {
        #[command(subcommand)]
        command: IssueCommand,
    },
    /// Inspect persona permissions and the access audit log.
    Access {
        #[command(subcommand)]
        command: AccessCommand,
    },
}

#[derive(Debug, Subcommand)]
pub(super) enum TaskCommand {
    /// Store a task; `serve` or `task run` processes it.
    Submit {
        objective: String,
        /// Acceptance criterion (repeatable).
        #[arg(long)]
        accept: Vec<String>,
        /// Required capability tag (repeatable).
        #[arg(long)]
        cap: Vec<String>,
        #[arg(long)]
        workspace: Option<String>,
        /// JSON file with a structured plan: {"tasks":[...]}.
        #[arg(long)]
        plan_file: Option<PathBuf>,
        /// Idempotency key: resubmitting the same key returns the same task.
        #[arg(long)]
        key: Option<String>,
    },
    List {
        #[arg(long)]
        status: Option<String>,
    },
    Show {
        id: String,
    },
    /// List agent messages under a root task, optionally one thread.
    Messages {
        root: String,
        /// Only messages in this thread (a thread id is its first message's id).
        #[arg(long)]
        thread: Option<String>,
    },
    Cancel {
        id: String,
    },
    Pause {
        id: String,
    },
    Resume {
        id: String,
        /// Authorize replaying attempts that were interrupted or ended without a result.
        #[arg(long)]
        retry: bool,
    },
    /// Follow a task's events until it finishes; Ctrl-C only stops watching.
    Watch {
        id: String,
        #[arg(long, default_value_t = 1000)]
        poll_ms: u64,
    },
    /// Process stored tasks in the foreground.
    Run {
        /// Exit once nothing is claimable instead of running until Ctrl-C.
        #[arg(long)]
        until_idle: bool,
    },
}

#[derive(Debug, Subcommand)]
pub(super) enum IssueCommand {
    /// List backlog issues. They are not implemented from here.
    List {
        /// `open` (default), `dismissed`, or `all`.
        #[arg(long)]
        status: Option<String>,
        /// `feature`, `improvement`, or `bug`.
        #[arg(long)]
        kind: Option<String>,
    },
    Show {
        id: String,
    },
    /// Close an issue without implementing it.
    Dismiss {
        id: String,
        #[arg(long)]
        reason: Option<String>,
    },
    /// Run one council now. `serve` also runs councils on the configured cadence.
    Run,
}

#[derive(Debug, Subcommand)]
pub(super) enum AccessCommand {
    /// Show each persona's roles and effective permissions.
    Show,
    /// List gated allow/deny decisions, newest first.
    Audit {
        #[arg(long, default_value_t = 50)]
        limit: usize,
        /// Only decisions for this persona.
        #[arg(long)]
        persona: Option<String>,
        /// Only denials.
        #[arg(long)]
        denied: bool,
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
