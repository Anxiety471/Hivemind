mod config;
mod runtime;
mod setup;

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use tokio::io::{self, AsyncBufReadExt, AsyncWriteExt, BufReader};

use config::{AgentConfig, HivemindConfig};
use runtime::AgentManager;

#[derive(Debug, Parser)]
#[command(
    name = "hivemind",
    version,
    about = "Runtime-agnostic meta-harness for AI agents"
)]
struct Cli {
    #[arg(long, global = true, default_value = "hivemind.toml")]
    config: PathBuf,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Create a starter Hivemind configuration.
    Init {
        /// Replace an existing config file.
        #[arg(long)]
        force: bool,
    },

    /// Start the interactive CLI.
    Chat,

    /// Check local configuration and runtime executables.
    Doctor,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Some(Commands::Init { force }) => {
            HivemindConfig::write_default(&cli.config, force)?;
            println!("Created {}", cli.config.display());
            println!("Inspect it, configure a provider in Pi/OMP, then run: cargo run -- doctor");
        }
        Some(Commands::Doctor) => {
            let config = HivemindConfig::load(&cli.config)?;
            setup::doctor(&cli.config, &config)?;
        }
        Some(Commands::Chat) | None => {
            let config = HivemindConfig::load(&cli.config)?;
            setup::validate(&config)?;
            chat(config).await?;
        }
    }

    Ok(())
}

async fn chat(config: HivemindConfig) -> Result<()> {
    println!("Hivemind POC");
    println!(
        "{} agent(s) connected through configured harnesses.",
        config.agents.len()
    );
    let agents = config.ordered_agents();
    print_agents(&agents);
    println!("Type /help for commands.");

    // One live session per agent, started before the first prompt so a
    // startup failure reports which agent failed and why.
    let manager = AgentManager::start(&config.runtime, &agents).await?;

    // Every exit path — quit, EOF, read errors, and Ctrl-C — falls through
    // to the bounded shutdown below so no orphaned OMP processes remain.
    let result = tokio::select! {
        result = chat_loop(&config, &manager) => result,
        signal = tokio::signal::ctrl_c() => match signal {
            Ok(()) => {
                println!();
                Ok(())
            }
            Err(error) => Err(error.into()),
        },
    };

    manager.shutdown().await;

    result
}

async fn chat_loop(config: &HivemindConfig, manager: &AgentManager) -> Result<()> {
    let mut lines = BufReader::new(io::stdin()).lines();
    let mut stdout = io::stdout();

    loop {
        stdout.write_all(b"\nYou> ").await?;
        stdout.flush().await?;

        let Some(line) = lines.next_line().await? else {
            println!();
            break;
        };

        let input = line.trim();

        if input.is_empty() {
            continue;
        }

        match input {
            "/quit" | "/exit" => break,
            "/agents" => {
                print_agents(&config.ordered_agents());
                continue;
            }
            "/help" => {
                println!("/agents  list configured agents");
                println!("/help    show this help");
                println!("/quit    exit Hivemind");
                continue;
            }
            _ => {}
        }

        run_turn(manager, input).await;
    }

    Ok(())
}

async fn run_turn(manager: &AgentManager, input: &str) {
    let replies = manager.prompt_all(input).await;

    for (name, result) in &replies.replies {
        match result {
            Ok(response) => println!("\n{name}> {response}"),
            Err(error) => eprintln!("\n{name}> [error] {error:#}"),
        }
    }
}

fn print_agents(agents: &[&AgentConfig]) {
    for agent in agents {
        println!("  - {} [{}]", agent.name, agent.runtime);
    }
}
