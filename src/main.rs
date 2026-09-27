mod config;
mod runtime;

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use tokio::{
    io::{self, AsyncBufReadExt, AsyncWriteExt, BufReader},
    task::JoinSet,
};

use config::{AgentConfig, HivemindConfig, RuntimeConfig};

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
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Some(Commands::Init { force }) => {
            HivemindConfig::write_default(&cli.config, force)?;
            println!("Created {}", cli.config.display());
            println!("Edit it if you want, then run: cargo run");
        }
        Some(Commands::Chat) | None => {
            let config = HivemindConfig::load(&cli.config)?;
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
    print_agents(&config.agents);
    println!("Type /help for commands.");

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
                print_agents(&config.agents);
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

        run_turn(&config.runtime, &config.agents, input).await;
    }

    Ok(())
}

async fn run_turn(runtime: &RuntimeConfig, agents: &[AgentConfig], input: &str) {
    let mut jobs = JoinSet::new();

    for (index, agent) in agents.iter().cloned().enumerate() {
        let runtime = runtime.clone();
        let input = input.to_string();

        jobs.spawn(async move {
            let name = agent.name.clone();
            let result = runtime::invoke_agent(&runtime, &agent, &input).await;
            (index, name, result)
        });
    }

    let mut replies = Vec::with_capacity(agents.len());

    while let Some(joined) = jobs.join_next().await {
        match joined {
            Ok(reply) => replies.push(reply),
            Err(error) => eprintln!("Harness task failed: {error}"),
        }
    }

    replies.sort_by_key(|(index, _, _)| *index);

    for (_, name, result) in replies {
        match result {
            Ok(response) => println!("\n{name}> {response}"),
            Err(error) => eprintln!("\n{name}> [error] {error:#}"),
        }
    }
}

fn print_agents(agents: &[AgentConfig]) {
    for agent in agents {
        println!("  - {} [{}]", agent.name, agent.runtime);
    }
}
