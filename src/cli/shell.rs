use std::path::Path;

use anyhow::Result;
use hivemind::{config::HivemindConfig, core::HivemindCore};
use tokio::io::{self, AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::{
    app::{conversation_target, print_replies, route_turn},
    groups::{group_member_summary, mutate_group_and_reload, render_group},
    render::{effective_agents, print_agents, print_order, status},
};
use crate::commands::GroupCommand;
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Route {
    Main,
    Solo(String),
    Group(String),
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum InteractiveCommand {
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
pub(super) enum GroupAction {
    Create(String, Vec<String>),
    List,
    Show(String),
    Use(String),
    Add(String, String),
    Remove(String, String),
    Delete(String),
}
pub(super) async fn chat(config: &mut HivemindConfig, path: &Path, mut route: Route) -> Result<()> {
    let core = HivemindCore::new(config.clone(), path)?;
    route_names(&core, &route)?;
    println!("Hivemind — {}", route_label(&route));
    println!(
        "{} agent(s) configured. Type /help for commands.",
        config.agents.len()
    );
    print_agents(&effective_agents(config));
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let mut chat = Box::pin(chat_loop(config, &core, path, &mut route, shutdown_rx));
    let result = tokio::select! {
        result = &mut chat => {
            core.shutdown().await;
            result
        },
        signal = tokio::signal::ctrl_c() => match signal {
            Ok(()) => {
                println!();
                shutdown_tx.send_replace(true);
                let (_, result) = tokio::join!(core.shutdown(), &mut chat);
                result
            },
            Err(error) => {
                shutdown_tx.send_replace(true);
                let (_, _) = tokio::join!(core.shutdown(), &mut chat);
                Err(error.into())
            },
        }
    };
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
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    let mut lines = BufReader::new(io::stdin()).lines();
    let mut out = io::stdout();
    loop {
        out.write_all(format!("\nYou [{}]> ", route_label(route)).as_bytes())
            .await?;
        out.flush().await?;
        let line = tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            line = lines.next_line() => line?,
        };
        let Some(line) = line else {
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
                    if *shutdown.borrow() {
                        break;
                    }
                    continue;
                }
            }
        }
        if let Err(error) = route_turn(core, route, input).await.and_then(print_replies) {
            eprintln!("error: {error:#}");
        }
        if *shutdown.borrow() {
            break;
        }
    }
    Ok(())
}
pub(super) fn route_names(core: &HivemindCore, route: &Route) -> Result<Vec<String>> {
    let resolved = core.resolve_target(&conversation_target(route))?;
    Ok(resolved
        .participants
        .into_iter()
        .map(|participant| participant.agent.name.clone())
        .collect())
}

pub(super) fn delete_group(
    config: &mut HivemindConfig,
    path: &std::path::Path,
    core: &HivemindCore,
    route: &mut Route,
    name: &str,
) -> Result<()> {
    mutate_group_and_reload(
        config,
        path,
        Some(core),
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
            print_replies(route_turn(core, &Route::Solo(name), &message).await?)?;
        }
        InteractiveCommand::All(message) => {
            print_replies(route_turn(core, &Route::Main, &message).await?)?;
        }
        InteractiveCommand::Solo(name) => {
            core.resolve_target(&conversation_target(&Route::Solo(name.clone())))?;
            *route = Route::Solo(name);
        }
        InteractiveCommand::Main => *route = Route::Main,
        InteractiveCommand::Group(action) => match action {
            GroupAction::Create(name, agents) => mutate_group_and_reload(
                config,
                path,
                Some(core),
                GroupCommand::Create { name, agents },
            )?,
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
                core.resolve_target(&conversation_target(&Route::Group(name.clone())))?;
                *route = Route::Group(name);
            }
            GroupAction::Add(name, agent) => {
                mutate_group_and_reload(
                    config,
                    path,
                    Some(core),
                    GroupCommand::Add { name, agent },
                )?;
            }
            GroupAction::Remove(name, agent) => {
                mutate_group_and_reload(
                    config,
                    path,
                    Some(core),
                    GroupCommand::Remove { name, agent },
                )?;
            }
            GroupAction::Delete(name) => delete_group(config, path, core, route, &name)?,
        },
        InteractiveCommand::Quit | InteractiveCommand::Unknown | InteractiveCommand::Invalid(_) => {
            unreachable!()
        }
    }
    Ok(())
}
pub(super) fn parse_interactive(input: &str) -> InteractiveCommand {
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
