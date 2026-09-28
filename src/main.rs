mod commands;
mod setup;
use std::{fmt::Write as _, path::PathBuf, process, sync::Arc};

use anyhow::{bail, Result};
use clap::{Parser, Subcommand};
use hivemind::{
    api,
    config::{AgentConfig, ConversationMode, HivemindConfig},
    conversation::Participant,
    core::{CoreTurnRequest, HivemindCore},
};
use tokio::io::{self, AsyncBufReadExt, AsyncWriteExt, BufReader};

use commands::{mutate_group, GroupCommand};

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
enum ShellGroupCommand {
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

#[derive(Debug, Clone, PartialEq, Eq)]
enum Route {
    Main,
    Solo(String),
    Group(String),
}

#[derive(Debug, PartialEq, Eq)]
enum InteractiveCommand {
    Help,
    Agents,
    Status,
    Order,
    Where,
    Ask(String, String),
    All(String),
    Solo(String),
    Main,
    Group(GroupAction),
    Quit,
    Unknown,
    Invalid(String),
}
#[derive(Debug, PartialEq, Eq)]
enum GroupAction {
    Create(String, Vec<String>),
    List,
    Show(String),
    Use(String),
    Add(String, String),
    Remove(String, String),
    Delete(String),
}

#[tokio::main]
async fn main() {
    if let Err(error) = run(Cli::parse()).await {
        eprintln!("error: {error:#}");
        process::exit(1);
    }
}

async fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Some(Commands::Init { force }) => {
            HivemindConfig::write_default(&cli.config, force)?;
            println!("Created {}", cli.config.display());
            Ok(())
        }
        Some(Commands::Serve { port }) => {
            let config = HivemindConfig::load(&cli.config)?;
            let core = Arc::new(HivemindCore::new(config, &cli.config)?);
            let result = api::serve(core.clone(), port).await;
            core.shutdown().await;
            result
        }
        Some(command) => {
            let needs_config = !matches!(command, Commands::Init { .. });
            if !needs_config {
                return Ok(());
            }
            let mut config = HivemindConfig::load(&cli.config)?;
            match command {
                Commands::Doctor => setup::doctor(&cli.config, &config),
                Commands::Serve { .. } => unreachable!("serve is handled before CLI config loading"),
                Commands::Chat { solo, group } => {
                    let route = if let Some(name) = solo {
                        commands::agent(&config, &name)?;
                        Route::Solo(name)
                    } else if let Some(name) = group {
                        commands::group_agents(&config, &name)?;
                        Route::Group(name)
                    } else {
                        Route::Main
                    };
                    chat(&mut config, &cli.config, route).await
                }
                Commands::Agents => {
                    print_agents(&effective_agents(&config));
                    Ok(())
                }
                Commands::Order => {
                    print_order(&effective_agents(&config));
                    Ok(())
                }
                Commands::Status => status(&config),
                Commands::Ask { agent, message } => ask(&config, &cli.config, &agent, &message).await,
                Commands::All { message } => all(&config, &cli.config, &message).await,
                Commands::Group { command } => group_command(&mut config, &cli.config, command),
                Commands::Init { .. } => unreachable!(),
            }
        }
        None => {
            let mut config = HivemindConfig::load(&cli.config)?;
            chat(&mut config, &cli.config, Route::Main).await
        }
    }
}

fn group_command(
    config: &mut HivemindConfig,
    path: &std::path::Path,
    command: ShellGroupCommand,
) -> Result<()> {
    match command {
        ShellGroupCommand::Create { name, agents } => {
            mutate_group(config, path, GroupCommand::Create { name, agents })
        }
        ShellGroupCommand::List => {
            println!("Groups:");
            for g in &config.groups {
                println!(
                    "  {:<12} {}",
                    g.name,
                    group_member_summary(config, &g.name)?
                );
            }
            Ok(())
        }
        ShellGroupCommand::Show { name } => {
            print!("{}", render_group(config, &name)?);
            Ok(())
        }
        ShellGroupCommand::Add { name, agent } => {
            mutate_group(config, path, GroupCommand::Add { name, agent })
        }
        ShellGroupCommand::Remove { name, agent } => {
            mutate_group(config, path, GroupCommand::Remove { name, agent })
        }
        ShellGroupCommand::Delete { name } => {
            mutate_group(config, path, GroupCommand::Delete { name })
        }
    }
}

fn group_member_summary(config: &HivemindConfig, name: &str) -> Result<String> {
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

fn render_group(config: &HivemindConfig, name: &str) -> Result<String> {
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

fn print_agents<A: std::borrow::Borrow<AgentConfig>>(agents: &[A]) {
    println!("Agents:");
    for (i, agent) in agents.iter().enumerate() {
        let a = agent.borrow();
        println!("  {}. {} [{}]", i + 1, a.name, a.runtime);
    }
}
fn print_order<A: std::borrow::Borrow<AgentConfig>>(agents: &[A]) {
    println!("Reply order:");
    for (i, agent) in agents.iter().enumerate() {
        println!("  {}. {}", i + 1, agent.borrow().name);
    }
}

fn effective_agents(config: &HivemindConfig) -> Vec<&AgentConfig> {
    config.ordered_agents()
}
fn status(config: &HivemindConfig) -> Result<()> {
    println!("Agents: {}", config.agents.len());
    println!(
        "Runtimes: {}",
        config
            .agents
            .iter()
            .map(|a| a.runtime.as_str())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
            .join(", ")
    );
    println!("Groups:");
    for group in &config.groups {
        println!(
            "  {}: {}",
            group.name,
            if group.members.is_empty() {
                "(no agents)".into()
            } else {
                group.members.join(", ")
            }
        );
    }
    print_order(&effective_agents(config));
    for agent in &config.agents {
        let bin = match agent.runtime.as_str() {
            "omp" => &config.runtime.omp_binary,
            "pi" => &config.runtime.pi_binary,
            _ => continue,
        };
        println!(
            "Runtime executable '{bin}': {}",
            setup::resolve_runtime_binary(bin)
                .map_or_else(|| "not found".to_string(), |p| p.display().to_string())
        );
    }
    Ok(())
}

async fn ask(
    config: &HivemindConfig,
    config_path: &std::path::Path,
    name: &str,
    message: &str,
) -> Result<()> {
    let core = HivemindCore::new(config.clone(), config_path)?;
    let result = route_turn_one_shot(&core, config, &Route::Solo(name.to_owned()), message)
        .await
        .and_then(print_replies);
    core.shutdown().await;
    result
}

#[derive(Debug)]
struct ReplyBatch {
    replies: Vec<(String, Result<String>)>,
}

fn visit_replies(
    replies: &[(String, Result<String>)],
    mut emit: impl FnMut(&str, &Result<String>),
) -> bool {
    let mut failed = false;
    for (name, result) in replies {
        emit(name, result);
        failed |= result.is_err();
    }
    failed
}

fn print_replies(replies: ReplyBatch) -> Result<()> {
    let failed = visit_replies(&replies.replies, |name, result| match result {
        Ok(text) => println!("\n{name}> {text}"),
        Err(error) => eprintln!("\n{name}> [error] {error:#}"),
    });
    if failed {
        bail!("one or more agents failed");
    }
    Ok(())
}

async fn all(
    config: &HivemindConfig,
    config_path: &std::path::Path,
    message: &str,
) -> Result<()> {
    let core = HivemindCore::new(config.clone(), config_path)?;
    let result = route_turn_one_shot(&core, config, &Route::Main, message)
        .await
        .and_then(print_replies);
    core.shutdown().await;
    result
}

fn route_identity(
    config: &HivemindConfig,
    route: &Route,
) -> Result<(String, String, String, ConversationMode, Vec<Participant>)> {
    Ok(match route {
        Route::Main => (
            "main".to_owned(),
            "Main conversation".to_owned(),
            String::new(),
            ConversationMode::Broadcast,
            config
                .ordered_agents()
                .into_iter()
                .map(|agent| Participant {
                    agent: agent.clone(),
                    role: None,
                })
                .collect(),
        ),
        Route::Solo(name) => {
            let agent = commands::agent(config, name)?;
            (
                format!("solo-{name}"),
                format!("Solo: {name}"),
                String::new(),
                ConversationMode::Discussion,
                vec![Participant {
                    agent: agent.clone(),
                    role: None,
                }],
            )
        }
        Route::Group(name) => {
            let group = commands::group(config, name)?;
            let participants = commands::group_agents(config, name)?
                .into_iter()
                .map(|agent| Participant {
                    agent: agent.clone(),
                    role: group.member_roles.get(&agent.name).cloned(),
                })
                .collect();
            (
                format!("group-{name}"),
                group.name.clone(),
                group.name.clone(),
                group.mode,
                participants,
            )
        }
    })
}

async fn route_turn(
    core: &HivemindCore,
    config: &HivemindConfig,
    route: &Route,
    message: &str,
) -> Result<ReplyBatch> {
    dispatch_route_turn(core, config, route, message, false).await
}

async fn route_turn_one_shot(
    core: &HivemindCore,
    config: &HivemindConfig,
    route: &Route,
    message: &str,
) -> Result<ReplyBatch> {
    dispatch_route_turn(core, config, route, message, true).await
}

async fn dispatch_route_turn(
    core: &HivemindCore,
    config: &HivemindConfig,
    route: &Route,
    message: &str,
    one_shot: bool,
) -> Result<ReplyBatch> {
    let (room_id, room_name, group_id, mode, participants) = route_identity(config, route)?;
    let request = CoreTurnRequest {
        room: &room_id,
        room_name: &room_name,
        group_id: &group_id,
        mode,
        members: &participants,
        input: message,
    };
    let replies = if one_shot {
        core.turn_one_shot(request).await?
    } else {
        core.turn(request).await?
    };
    Ok(ReplyBatch {
        replies: replies
            .into_iter()
            .map(|reply| (reply.name, reply.result.map_err(anyhow::Error::msg)))
            .collect(),
    })
}

async fn chat(config: &mut HivemindConfig, path: &std::path::Path, mut route: Route) -> Result<()> {
    route_names(config, &route)?;
    println!("Hivemind — {}", route_label(&route));
    println!(
        "{} agent(s) configured. Type /help for commands.",
        config.agents.len()
    );
    print_agents(&effective_agents(config));
    let core = HivemindCore::new(config.clone(), path)?;
    let result = tokio::select! {
        result = chat_loop(config, &core, path, &mut route) => result,
        signal = tokio::signal::ctrl_c() => match signal {
            Ok(()) => { println!(); Ok(()) },
            Err(error) => Err(error.into()),
        }
    };
    core.shutdown().await;
    result
}
fn route_label(route: &Route) -> String {
    match route {
        Route::Main => "main".into(),
        Route::Solo(n) => format!("solo:{n}"),
        Route::Group(n) => format!("group:{n}"),
    }
}

async fn chat_loop(
    config: &mut HivemindConfig,
    core: &HivemindCore,
    path: &std::path::Path,
    route: &mut Route,
) -> Result<()> {
    let mut lines = BufReader::new(io::stdin()).lines();
    let mut out = io::stdout();
    loop {
        out.write_all(format!("\nYou [{}]> ", route_label(route)).as_bytes())
            .await?;
        out.flush().await?;
        let Some(line) = lines.next_line().await? else {
            println!();
            break;
        };
        let input = line.trim();
        if input.is_empty() {
            continue;
        }
        if input.starts_with('/') {
            match parse_interactive(input) {
                InteractiveCommand::Quit => break,
                InteractiveCommand::Unknown => {
                    eprintln!("unknown command; type /help");
                    continue;
                }
                InteractiveCommand::Invalid(usage) => {
                    eprintln!("usage: {usage}");
                    continue;
                }
                command => {
                    if let Err(error) = handle_interactive(config, path, core, route, command).await
                    {
                        eprintln!("error: {error:#}");
                    }
                    continue;
                }
            }
        }
        if let Err(error) = route_turn(core, config, route, input)
            .await
            .and_then(print_replies)
        {
            eprintln!("error: {error:#}");
        }
    }
    Ok(())
}
fn route_names(config: &HivemindConfig, route: &Route) -> Result<Vec<String>> {
    match route {
        Route::Main => Ok(config
            .ordered_agents()
            .into_iter()
            .map(|a| a.name.clone())
            .collect()),
        Route::Solo(name) => {
            commands::agent(config, name)?;
            Ok(vec![name.clone()])
        }
        Route::Group(name) => Ok(commands::group_agents(config, name)?
            .into_iter()
            .map(|a| a.name.clone())
            .collect()),
    }
}

fn delete_group(
    config: &mut HivemindConfig,
    path: &std::path::Path,
    route: &mut Route,
    name: &str,
) -> Result<()> {
    mutate_group(
        config,
        path,
        GroupCommand::Delete {
            name: name.to_string(),
        },
    )?;
    if route == &Route::Group(name.to_string()) {
        *route = Route::Main;
    }
    Ok(())
}

async fn handle_interactive(
    config: &mut HivemindConfig,
    path: &std::path::Path,
    core: &HivemindCore,
    route: &mut Route,
    command: InteractiveCommand,
) -> Result<()> {
    match command {
        InteractiveCommand::Help => {
            println!(
                "/help /agents /status /order /where\n\
                 /ask <agent> <message> /all <message>\n\
                 /solo <agent> /main\n\
                 /group create|list|show|use|add|remove|delete ...\n\
                 /quit (/exit)"
            );
        }
        InteractiveCommand::Agents => print_agents(&effective_agents(config)),
        InteractiveCommand::Status => status(config)?,
        InteractiveCommand::Order => print_order(&effective_agents(config)),
        InteractiveCommand::Where => println!("{}", route_label(route)),
        InteractiveCommand::Ask(name, message) => {
            print_replies(route_turn(core, config, &Route::Solo(name), &message).await?)?;
        }
        InteractiveCommand::All(message) => {
            print_replies(route_turn(core, config, &Route::Main, &message).await?)?;
        }
        InteractiveCommand::Solo(name) => {
            commands::agent(config, &name)?;
            *route = Route::Solo(name);
        }
        InteractiveCommand::Main => *route = Route::Main,
        InteractiveCommand::Group(action) => match action {
            GroupAction::Create(name, agents) => {
                mutate_group(config, path, GroupCommand::Create { name, agents })?
            }
            GroupAction::List => {
                for group in &config.groups {
                    println!(
                        "{}: {}",
                        group.name,
                        group_member_summary(config, &group.name)?
                    );
                }
            }
            GroupAction::Show(name) => print!("{}", render_group(config, &name)?),
            GroupAction::Use(name) => {
                commands::group_agents(config, &name)?;
                *route = Route::Group(name);
            }
            GroupAction::Add(name, agent) => {
                mutate_group(config, path, GroupCommand::Add { name, agent })?;
            }
            GroupAction::Remove(name, agent) => {
                mutate_group(config, path, GroupCommand::Remove { name, agent })?;
            }
            GroupAction::Delete(name) => delete_group(config, path, route, &name)?,
        },
        InteractiveCommand::Quit | InteractiveCommand::Unknown | InteractiveCommand::Invalid(_) => {
            unreachable!()
        }
    }
    Ok(())
}
fn parse_interactive(input: &str) -> InteractiveCommand {
    let mut parts = input.splitn(2, char::is_whitespace);
    let command = parts.next().unwrap_or("");
    let rest = parts.next().unwrap_or("").trim();
    let args = rest.split_whitespace().collect::<Vec<_>>();
    match command {
        "/help" if rest.is_empty() => InteractiveCommand::Help,
        "/agents" if rest.is_empty() => InteractiveCommand::Agents,
        "/status" if rest.is_empty() => InteractiveCommand::Status,
        "/order" if rest.is_empty() => InteractiveCommand::Order,
        "/where" if rest.is_empty() => InteractiveCommand::Where,
        "/quit" | "/exit" if rest.is_empty() => InteractiveCommand::Quit,
        "/main" if rest.is_empty() => InteractiveCommand::Main,
        "/solo" if args.len() == 1 => InteractiveCommand::Solo(args[0].into()),
        "/ask" => {
            let mut p = rest.splitn(2, char::is_whitespace);
            match (p.next(), p.next()) {
                (Some(a), Some(m)) if !m.trim().is_empty() => {
                    InteractiveCommand::Ask(a.into(), m.trim().into())
                }
                _ => InteractiveCommand::Invalid("/ask <agent> <message>".into()),
            }
        }
        "/all" if !rest.is_empty() => InteractiveCommand::All(rest.into()),
        "/group" => parse_group(args),
        "/help" => InteractiveCommand::Invalid("/help".into()),
        "/solo" => InteractiveCommand::Invalid("/solo <agent>".into()),
        "/all" => InteractiveCommand::Invalid("/all <message>".into()),
        "/main" | "/agents" | "/status" | "/order" | "/where" | "/quit" | "/exit" => {
            InteractiveCommand::Invalid(command.to_string())
        }
        _ => InteractiveCommand::Unknown,
    }
}
fn parse_group(args: Vec<&str>) -> InteractiveCommand {
    if args.is_empty() {
        return InteractiveCommand::Invalid(
            "/group <create|list|show|use|add|remove|delete> ...".into(),
        );
    }
    match args[0]{"list" if args.len()==1=>InteractiveCommand::Group(GroupAction::List),"create" if args.len()>=2=>InteractiveCommand::Group(GroupAction::Create(args[1].into(),args[2..].iter().map(|s|(*s).into()).collect())),"show"|"use"|"delete" if args.len()==2=>{let n=args[1].into();InteractiveCommand::Group(match args[0]{"show"=>GroupAction::Show(n),"use"=>GroupAction::Use(n),_=>GroupAction::Delete(n)})},"add"|"remove" if args.len()==3=>InteractiveCommand::Group(if args[0]=="add"{GroupAction::Add(args[1].into(),args[2].into())}else{GroupAction::Remove(args[1].into(),args[2].into())}),_=>InteractiveCommand::Invalid("/group create <name> [agent...], list, show <name>, use <name>, add <name> <agent>, remove <name> <agent>, delete <name>".into())}
}

#[cfg(test)]
mod tests {
    use super::*;
    use hivemind::config;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use clap::CommandFactory;

    static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "hivemind-{label}-{}-{}",
                process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct FakePi {
        directory: TestDirectory,
        binary: PathBuf,
        log: PathBuf,
        prompt_log: PathBuf,
    }

    impl FakePi {
        fn new() -> Self {
            let directory = TestDirectory::new("cli-runtime");
            let binary = directory.0.join("fake-pi");
            let log = directory.0.join("lifecycle.log");
            let prompt_log = directory.0.join("prompts.jsonl");
            let script = r#"#!/bin/sh
case "$*" in
  *"You are Maomao"*) agent=Maomao ;;
  *"You are Albedo"*) agent=Albedo ;;
  *) agent=Unknown ;;
esac
printf '%s started\n' "$agent" >> __LOG__
while IFS= read -r request; do
  case "$request" in
    *'"type":"new_session"'*)
      printf '%s\n' '{"type":"response","command":"new_session","success":true}'
      ;;
    *'"type":"prompt"'*)
      printf '%s prompt\n' "$agent" >> __LOG__
      printf '%s\n' "$request" >> __PROMPT_LOG__
      printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"%s reply"}]}}\n' "$agent"
      printf '%s\n' '{"type":"agent_settled"}'
      ;;
  esac
done
printf '%s stopped\n' "$agent" >> __LOG__
"#
            .replace("__LOG__", &format!("'{}'", log.display()))
            .replace("__PROMPT_LOG__", &format!("'{}'", prompt_log.display()));
            fs::write(&binary, script).unwrap();
            let mut permissions = fs::metadata(&binary).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&binary, permissions).unwrap();
            Self {
                directory,
                binary,
                log,
                prompt_log,
            }
        }

        fn config(&self) -> HivemindConfig {
            let mut config = HivemindConfig::default_poc();
            config.runtime.pi_binary = self.binary.display().to_string();
            for agent in &mut config.agents {
                agent.workspace = self.directory.0.display().to_string();
            }
            config
        }

        fn prompt_lines(&self) -> Vec<String> {
            fs::read_to_string(&self.prompt_log)
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect()
        }
        fn log_lines(&self) -> Vec<String> {
            fs::read_to_string(&self.log)
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect()
        }
    }

    fn capture_replies(replies: &ReplyBatch) -> (String, bool) {
        let mut output = String::new();
        let failed = visit_replies(&replies.replies, |name, result| match result {
            Ok(text) => output.push_str(&format!("\n{name}> {text}\n")),
            Err(error) => output.push_str(&format!("\n{name}> [error] {error:#}\n")),
        });
        (output, failed)
    }

    #[test]
    fn mixed_reply_outcomes_keep_their_order_and_failure_status() {
        let replies = vec![
            ("First".into(), Ok("first response".into())),
            ("Middle".into(), Err(anyhow::anyhow!("middle failed"))),
            ("Last".into(), Ok("last response".into())),
        ];
        let mut observed = Vec::new();
        let failed = visit_replies(&replies, |name, result| match result {
            Ok(text) => observed.push(format!("{name}: {text}")),
            Err(error) => observed.push(format!("{name}: error: {error}")),
        });

        assert!(failed);
        assert_eq!(
            observed,
            [
                "First: first response",
                "Middle: error: middle failed",
                "Last: last response",
            ]
        );
    }
    #[test]
    fn shell_help_has_all_top_level_commands() {
        let mut cmd = Cli::command();
        let mut b = Vec::new();
        cmd.write_long_help(&mut b).unwrap();
        let s = String::from_utf8(b).unwrap();
        for word in [
            "init", "doctor", "chat", "agents", "status", "order", "ask", "all", "group",
        ] {
            assert!(s.contains(word));
        }
    }
    #[test]
    fn interactive_parser_recognizes_routes_and_rejects_unknown() {
        assert_eq!(
            parse_interactive("/ask Albedo review this"),
            InteractiveCommand::Ask("Albedo".into(), "review this".into())
        );
        assert_eq!(
            parse_interactive("/all hello there"),
            InteractiveCommand::All("hello there".into())
        );
        assert_eq!(
            parse_interactive("/group use backend"),
            InteractiveCommand::Group(GroupAction::Use("backend".into()))
        );
        assert_eq!(parse_interactive("/what"), InteractiveCommand::Unknown);
    }
    #[test]
    fn clap_parses_every_shell_command_and_global_config_position() {
        let cases: &[&[&str]] = &[
            &["hivemind", "init"],
            &["hivemind", "init", "--force"],
            &["hivemind", "doctor"],
            &["hivemind", "chat"],
            &["hivemind", "chat", "--solo", "Albedo"],
            &["hivemind", "chat", "--group", "backend"],
            &["hivemind", "agents"],
            &["hivemind", "status"],
            &["hivemind", "order"],
            &["hivemind", "ask", "Albedo", "review this"],
            &["hivemind", "all", "review this"],
            &["hivemind", "group", "create", "backend", "Albedo", "Maomao"],
            &["hivemind", "group", "create", "empty"],
            &["hivemind", "group", "list"],
            &["hivemind", "group", "show", "backend"],
            &["hivemind", "group", "add", "backend", "Albedo"],
            &["hivemind", "group", "remove", "backend", "Albedo"],
            &["hivemind", "group", "delete", "backend"],
            &["hivemind", "serve"],
        ];
        for args in cases {
            assert!(
                Cli::try_parse_from(*args).is_ok(),
                "failed to parse {args:?}"
            );
        }

        for args in [
            &["hivemind", "--config", "custom.toml", "group", "list"][..],
            &["hivemind", "group", "list", "--config", "custom.toml"][..],
        ] {
            let cli = Cli::try_parse_from(args).unwrap();
            assert_eq!(cli.config, PathBuf::from("custom.toml"));
        }
    }
    #[tokio::test]
    async fn core_turns_persist_runtime_startup_failures_and_keep_peers() {
        let fake = FakePi::new();
        let mut config = fake.config();
        config.agents[0].runtime = "omp".into();
        config.runtime.omp_binary = format!("/hivemind-test-missing-omp-{}", process::id());
        let config_path = fake.directory.0.join("hivemind.toml");
        let core = HivemindCore::new(config.clone(), &config_path).unwrap();

        let replies = route_turn(&core, &config, &Route::Solo("Albedo".into()), "hello")
            .await
            .unwrap();
        let (output, failed) = capture_replies(&replies);
        assert_eq!(output, "\nAlbedo> Albedo reply\n");
        assert!(!failed);

        let replies = route_turn(&core, &config, &Route::Main, "hello").await.unwrap();
        let (_, failed) = capture_replies(&replies);
        assert!(failed);
        core.shutdown().await;
        assert_eq!(
            fake.log_lines(),
            ["Albedo started", "Albedo prompt", "Albedo prompt", "Albedo stopped"]
        );
        let history = core.conversation().room_history("main").unwrap();
        assert_eq!(history.events.len(), 3);
        let failed = history
            .events
            .iter()
            .find(|event| event.speaker == "Maomao")
            .unwrap();
        assert!(failed.error);
        let successful = history
            .events
            .iter()
            .find(|event| event.speaker == "Albedo")
            .unwrap();
        assert!(!successful.error);
        assert_eq!(successful.content, "Albedo reply");
    }
    #[tokio::test]
    async fn ask_executes_a_memory_tool_block_over_the_runtime_and_reprompts() {
        let directory = TestDirectory::new("tool-runtime");
        let binary = directory.0.join("fake-pi");
        let script = r#"#!/bin/sh
while IFS= read -r request; do
  case "$request" in
    *'"type":"new_session"'*)
      printf '%s\n' '{"type":"response","command":"new_session","success":true}'
      ;;
    *'"type":"prompt"'*)
      case "$request" in
        *'Memory tool exchange'*)
          printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done after tool"}]}}'
          ;;
        *)
          printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"```hivemind-tool\n{\"name\":\"memory.private.add\",\"args\":{\"content\":\"end-to-end note\"}}\n```"}]}}'
          ;;
      esac
      printf '%s\n' '{"type":"agent_settled"}'
      ;;
  esac
done
"#;
        fs::write(&binary, script).unwrap();
        let mut permissions = fs::metadata(&binary).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&binary, permissions).unwrap();

        let mut config = HivemindConfig::default_poc();
        config.runtime.pi_binary = binary.display().to_string();
        for agent in &mut config.agents {
            agent.workspace = directory.0.display().to_string();
        }
        let config_path = directory.0.join("hivemind.toml");
        let core = HivemindCore::new(config.clone(), &config_path).unwrap();

        let replies = route_turn(&core, &config, &Route::Solo("Albedo".into()), "store a note")
            .await
            .unwrap();
        core.shutdown().await;
        let (output, failed) = capture_replies(&replies);
        assert_eq!(output, "\nAlbedo> done after tool\n");
        assert!(!failed);

        // The executed write is bound to the solo invocation Hivemind created.
        let caller = hivemind::memory::Caller::agent(
            "solo-Albedo",
            "",
            "solo-Albedo/Albedo",
            "Albedo",
            "Albedo",
        );
        let found = core
            .memory()
            .store()
            .records_in_scope(
                &caller,
                &hivemind::memory::Scope::AgentInstance("solo-Albedo/Albedo".into()),
            )
            .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].content, "end-to-end note");
    }

    #[test]
    fn group_route_uses_global_order_and_empty_group_is_rejected() {
        let mut config = HivemindConfig::default_poc();
        config.conversation.reply_order = vec!["Albedo".into()];
        config.groups.push(config::GroupConfig {
            name: "backend".into(),
            members: vec!["Maomao".into(), "Albedo".into()],
            mode: config::ConversationMode::Broadcast,
            member_roles: Default::default(),
            reply_order: Default::default(),
        });
        assert_eq!(
            route_names(&config, &Route::Group("backend".into())).unwrap(),
            ["Albedo", "Maomao"]
        );
        config.groups[0].reply_order = vec!["Maomao".into()];
        assert_eq!(
            route_names(&config, &Route::Group("backend".into())).unwrap(),
            ["Maomao", "Albedo"]
        );
        config.groups[0].members.clear();
        assert!(route_names(&config, &Route::Group("backend".into())).is_err());
    }
    #[test]
    fn group_show_numbers_members_and_effective_order() {
        let mut config = HivemindConfig::default_poc();
        config.conversation.reply_order = vec!["Albedo".into()];
        config.groups.push(config::GroupConfig {
            name: "backend".into(),
            members: vec!["Maomao".into(), "Albedo".into()],
            mode: config::ConversationMode::Broadcast,
            member_roles: Default::default(),
            reply_order: Default::default(),
        });
        assert_eq!(
            render_group(&config, "backend").unwrap(),
            "Group: backend\nMembers:\n  1. Albedo [pi]\n  2. Maomao [pi]\n\n\
             Effective reply order:\n  1. Albedo\n  2. Maomao\n"
        );
    }
    #[tokio::test]
    async fn cli_group_role_override_reaches_context_pack() {
        let fake = FakePi::new();
        let config_path = fake.directory.0.join("hivemind.toml");
        let mut config = fake.config();
        config.groups.push(hivemind::config::GroupConfig {
            name: "review".into(),
            members: vec!["Albedo".into()],
            mode: ConversationMode::Discussion,
            member_roles: [("Albedo".into(), "Lead Reviewer".into())]
                .into_iter()
                .collect(),
            reply_order: vec!["Albedo".into()],
        });
        let core = HivemindCore::new(config.clone(), &config_path).unwrap();
        let replies = route_turn(&core, &config, &Route::Group("review".into()), "review this change")
            .await
            .unwrap();
        core.shutdown().await;
        assert_eq!(replies.replies.len(), 1);
        assert_eq!(replies.replies[0].0, "Albedo");
        assert!(replies.replies[0].1.as_ref().unwrap().contains("Albedo reply"));

        let prompts = fake.prompt_lines();
        assert_eq!(prompts.len(), 1);
        assert!(prompts[0].contains("You are Albedo. Your room role is Lead Reviewer."));
    }


    #[tokio::test]
    async fn one_core_reuses_runtimes_across_routes_and_rehydrates_room_context() {
        let fake = FakePi::new();
        let mut config = fake.config();
        config.groups.push(hivemind::config::GroupConfig {
            name: "review".into(),
            members: vec!["Albedo".into()],
            mode: ConversationMode::Discussion,
            member_roles: [("Albedo".into(), "Lead Reviewer".into())]
                .into_iter()
                .collect(),
            reply_order: vec!["Albedo".into()],
        });
        let config_path = fake.directory.0.join("hivemind.toml");
        let core = HivemindCore::new(config.clone(), &config_path).unwrap();

        for (route, input) in [
            (Route::Group("review".into()), "Goal: group objective\nfirst group turn"),
            (Route::Solo("Albedo".into()), "solo route turn"),
            (Route::Solo("Albedo".into()), "ask turn"),
            (Route::Main, "all turn"),
            (Route::Group("review".into()), "follow-up group turn"),
        ] {
            let replies = route_turn(&core, &config, &route, input).await.unwrap();
            assert!(replies.replies.iter().all(|(_, result)| result.is_ok()));
        }
        core.shutdown().await;

        let lifecycle = fake.log_lines();
        let count = |agent: &str, action: &str| {
            lifecycle
                .iter()
                .filter(|line| line.as_str() == format!("{agent} {action}"))
                .count()
        };
        for (agent, prompts) in [("Albedo", 5), ("Maomao", 1)] {
            assert_eq!(count(agent, "started"), 1);
            assert_eq!(count(agent, "prompt"), prompts);
            assert_eq!(count(agent, "stopped"), 1);
        }

        let prompts = fake.prompt_lines();
        assert_eq!(prompts.len(), 6);
        assert!(prompts[0].contains("Lead Reviewer"));
        assert!(prompts[1].contains("solo route turn"));
        assert!(!prompts[1].contains("group objective"));
        assert!(prompts[5].contains("group objective"));
        assert!(prompts[5].contains("first group turn"));
        assert!(prompts[5].contains("follow-up group turn"));
    }

    #[test]
    fn empty_group_show_and_listing_keep_empty_sections() {
        let mut config = HivemindConfig::default_poc();
        config.groups.push(config::GroupConfig {
            name: "empty".into(),
            members: Vec::new(),
            mode: config::ConversationMode::Broadcast,
            member_roles: Default::default(),
            reply_order: Vec::new(),
        });

        assert_eq!(
            render_group(&config, "empty").unwrap(),
            "Group: empty\nMembers:\n\nEffective reply order:\n"
        );
        assert_eq!(
            group_member_summary(&config, "empty").unwrap(),
            "(no agents)"
        );
        assert!(commands::group_agents(&config, "empty").is_err());
    }

    #[test]
    fn active_group_empty_turns_reject_and_delete_routes_to_main() {
        let directory = TestDirectory::new("active-group");
        let path = directory.0.join("config.toml");
        let mut config = HivemindConfig::default_poc();
        std::fs::write(&path, toml::to_string_pretty(&config).unwrap()).unwrap();
        commands::mutate_group(
            &mut config,
            &path,
            GroupCommand::Create {
                name: "backend".into(),
                agents: vec!["Albedo".into()],
            },
        )
        .unwrap();
        let mut route = Route::Group("backend".into());

        commands::mutate_group(
            &mut config,
            &path,
            GroupCommand::Remove {
                name: "backend".into(),
                agent: "Albedo".into(),
            },
        )
        .unwrap();
        assert!(route_names(&config, &route)
            .unwrap_err()
            .to_string()
            .contains("has no members"));

        delete_group(&mut config, &path, &mut route, "backend").unwrap();
        assert_eq!(route, Route::Main);
        assert!(HivemindConfig::load(&path).unwrap().groups.is_empty());
    }

    #[tokio::test]
    async fn ask_starts_only_its_agent_and_all_orders_output() {
        let fake = FakePi::new();
        let mut config = fake.config();
        config.conversation.reply_order = vec!["Albedo".into(), "Maomao".into()];
        config.agents[0].runtime = "unrelated-invalid-runtime".into();
        config.agents[0].workspace = "/missing/unrelated/workspace".into();
        let config_path = fake.directory.0.join("hivemind.toml");

        let core = HivemindCore::new(config.clone(), &config_path).unwrap();
        let unknown = route_turn(&core, &config, &Route::Solo("Missing".into()), "hello")
            .await
            .unwrap_err()
            .to_string();
        assert!(unknown.contains("no configured agent named 'Missing'"));
        assert!(fake.log_lines().is_empty());
        let ask_replies =
            route_turn_one_shot(&core, &config, &Route::Solo("Albedo".into()), "targeted")
            .await
            .unwrap();
        let (ask_output, ask_failed) = capture_replies(&ask_replies);
        assert_eq!(ask_output, "\nAlbedo> Albedo reply\n");
        assert!(!ask_failed);
        core.shutdown().await;
        assert_eq!(
            fake.log_lines(),
            ["Albedo started", "Albedo prompt", "Albedo stopped"]
        );

        config.agents[0].runtime = "pi".into();
        config.agents[0].workspace = fake.directory.0.display().to_string();
        fs::write(&fake.log, "").unwrap();
        let core = HivemindCore::new(config.clone(), &config_path).unwrap();
        let all_replies =
            route_turn_one_shot(&core, &config, &Route::Main, "broadcast prompt")
            .await
            .unwrap();
        core.shutdown().await;
        let (all_output, all_failed) = capture_replies(&all_replies);
        assert_eq!(
            all_output,
            "\nAlbedo> Albedo reply\n\nMaomao> Maomao reply\n"
        );
        assert!(!all_failed);
        let log = fake.log_lines();
        for event in [
            "Albedo started",
            "Albedo prompt",
            "Albedo stopped",
            "Maomao started",
            "Maomao prompt",
            "Maomao stopped",
        ] {
            assert!(
                log.iter().any(|line| line == event),
                "missing {event} in {log:?}"
            );
        }
        assert_eq!(log.len(), 6);
    }
}
