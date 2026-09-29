use anyhow::{bail, Result};
use clap::Parser;
use hivemind::{
    api,
    config::HivemindConfig,
    core::{ConversationTarget, HivemindCore},
};
use std::sync::Arc;

use super::args::{Cli, Commands};
use super::groups::group_command;
#[cfg(test)]
use super::groups::{group_member_summary, render_group};
use super::render::{effective_agents, print_agents, print_order, status};
use super::shell::{chat, Route};
#[cfg(test)]
use super::shell::{delete_group, parse_interactive, route_names, GroupAction, InteractiveCommand};
use crate::setup;

pub async fn entry() {
    if let Err(error) = run(Cli::parse()).await {
        eprintln!("error: {error:#}");
        std::process::exit(1);
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
                Commands::Serve { .. } => {
                    unreachable!("serve is handled before CLI config loading")
                }
                Commands::Chat { solo, group } => {
                    let route = if let Some(name) = solo {
                        Route::Solo(name)
                    } else if let Some(name) = group {
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
                Commands::Ask { agent, message } => {
                    ask(&config, &cli.config, &agent, &message).await
                }
                Commands::All { message } => all(&config, &cli.config, &message).await,
                Commands::Group { command } => {
                    group_command(&mut config, &cli.config, None, command)
                }
                Commands::Init { .. } => unreachable!(),
            }
        }
        None => {
            let mut config = HivemindConfig::load(&cli.config)?;
            chat(&mut config, &cli.config, Route::Main).await
        }
    }
}

async fn ask(
    config: &HivemindConfig,
    config_path: &std::path::Path,
    name: &str,
    message: &str,
) -> Result<()> {
    let core = HivemindCore::new(config.clone(), config_path)?;
    let result = route_turn(&core, &Route::Solo(name.to_owned()), message)
        .await
        .and_then(print_replies);
    core.shutdown().await;
    result
}
async fn all(config: &HivemindConfig, config_path: &std::path::Path, message: &str) -> Result<()> {
    let core = HivemindCore::new(config.clone(), config_path)?;
    let result = route_turn(&core, &Route::Main, message)
        .await
        .and_then(print_replies);
    core.shutdown().await;
    result
}

#[derive(Debug)]
pub(super) struct ReplyBatch {
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

pub(super) fn print_replies(replies: ReplyBatch) -> Result<()> {
    let failed = visit_replies(&replies.replies, |name, result| match result {
        Ok(text) => println!("\n{name}> {text}"),
        Err(error) => eprintln!("\n{name}> [error] {error:#}"),
    });
    if failed {
        bail!("one or more agents failed");
    }
    Ok(())
}

pub(super) fn conversation_target(route: &Route) -> ConversationTarget {
    match route {
        Route::Main => ConversationTarget::Main,
        Route::Solo(persona_id) => ConversationTarget::Solo {
            persona_id: persona_id.clone(),
        },
        Route::Group(group_id) => ConversationTarget::Group {
            group_id: group_id.clone(),
        },
    }
}

pub(super) async fn route_turn(
    core: &HivemindCore,
    route: &Route,
    message: &str,
) -> Result<ReplyBatch> {
    let outcome = core.send_turn(&conversation_target(route), message).await?;
    Ok(ReplyBatch {
        replies: outcome
            .replies
            .into_iter()
            .map(|reply| (reply.name, reply.result.map_err(anyhow::Error::msg)))
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::groups::mutate_group_and_reload;
    use crate::commands::{self, GroupCommand};
    use hivemind::config::{self, ConversationMode};
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::PathBuf,
        process,
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
  *"You are the Engineer"*) agent=Engineer ;;
  *"You are the Reviewer"*) agent=Reviewer ;;
  *) agent=Unknown ;;
esac
printf '%s started\n' "$agent" >> __LOG__
while IFS= read -r request; do
  case "$request" in
    *'"type":"new_session"'*)
      printf '%s\n' '{"type":"response","command":"new_session","success":true}'
      ;;
    *'"type":"get_session_stats"'*)
      printf '%s\n' '{"type":"response","command":"get_session_stats","success":true,"data":{}}'
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
            parse_interactive("/ask Reviewer review this"),
            InteractiveCommand::Ask("Reviewer".into(), "review this".into())
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
            &["hivemind", "chat", "--solo", "Reviewer"],
            &["hivemind", "chat", "--group", "backend"],
            &["hivemind", "agents"],
            &["hivemind", "status"],
            &["hivemind", "order"],
            &["hivemind", "ask", "Reviewer", "review this"],
            &["hivemind", "all", "review this"],
            &[
                "hivemind", "group", "create", "backend", "Reviewer", "Engineer",
            ],
            &["hivemind", "group", "create", "empty"],
            &["hivemind", "group", "list"],
            &["hivemind", "group", "show", "backend"],
            &["hivemind", "group", "add", "backend", "Reviewer"],
            &["hivemind", "group", "remove", "backend", "Reviewer"],
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

        let replies = route_turn(&core, &Route::Solo("Reviewer".into()), "hello")
            .await
            .unwrap();
        let (output, failed) = capture_replies(&replies);
        assert_eq!(output, "\nReviewer> Reviewer reply\n");
        assert!(!failed);

        let replies = route_turn(&core, &Route::Main, "hello").await.unwrap();
        let (_, failed) = capture_replies(&replies);
        assert!(failed);
        core.shutdown().await;
        let mut log = fake.log_lines();
        log.sort();
        assert_eq!(
            log,
            [
                "Reviewer prompt",
                "Reviewer prompt",
                "Reviewer started",
                "Reviewer started",
                "Reviewer stopped",
                "Reviewer stopped",
            ]
        );
        let history = core.conversation().room_history("main").unwrap();
        assert_eq!(history.events.len(), 3);
        let failed = history
            .events
            .iter()
            .find(|event| event.speaker == "Engineer")
            .unwrap();
        assert!(failed.error);
        let successful = history
            .events
            .iter()
            .find(|event| event.speaker == "Reviewer")
            .unwrap();
        assert!(!successful.error);
        assert_eq!(successful.content, "Reviewer reply");
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
    *'"type":"get_session_stats"'*)
      printf '%s\n' '{"type":"response","command":"get_session_stats","success":true,"data":{}}'
      ;;
    *'"type":"prompt"'*)
      case "$request" in
        *'Memory tool result:'*)
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

        let replies = route_turn(&core, &Route::Solo("Reviewer".into()), "store a note")
            .await
            .unwrap();
        core.shutdown().await;
        let (output, failed) = capture_replies(&replies);
        assert_eq!(output, "\nReviewer> done after tool\n");
        assert!(!failed);

        // The executed write is bound to the solo invocation Hivemind created.
        let instance = hivemind::identity::AgentInstanceId::new("solo-Reviewer", "Reviewer");
        let caller = hivemind::memory::Caller::agent(
            "solo-Reviewer",
            "",
            instance.clone(),
            "Reviewer",
            "Reviewer",
        );
        let found = core
            .memory()
            .store()
            .records_in_scope(&caller, &hivemind::memory::Scope::AgentInstance(instance))
            .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].content, "end-to-end note");
    }

    #[tokio::test]
    async fn group_route_uses_core_order_and_empty_group_is_rejected() {
        let directory = TestDirectory::new("group-route");
        let path = directory.0.join("config.toml");
        let mut config = HivemindConfig::default_poc();
        config.conversation.reply_order = vec!["Reviewer".into()];
        config.groups.push(config::GroupConfig {
            name: "backend".into(),
            members: vec!["Engineer".into(), "Reviewer".into()],
            mode: config::ConversationMode::Broadcast,
            member_roles: Default::default(),
            reply_order: Default::default(),
        });
        let core = HivemindCore::new(config.clone(), &path).unwrap();
        assert_eq!(
            route_names(&core, &Route::Group("backend".into())).unwrap(),
            ["Reviewer", "Engineer"]
        );
        config.groups[0].reply_order = vec!["Engineer".into()];
        core.reload_groups(config.groups.clone());
        assert_eq!(
            route_names(&core, &Route::Group("backend".into())).unwrap(),
            ["Engineer", "Reviewer"]
        );
        config.groups[0].members.clear();
        core.reload_groups(config.groups.clone());
        assert!(route_names(&core, &Route::Group("backend".into())).is_err());
        core.shutdown().await;
    }
    #[test]
    fn group_show_numbers_members_and_effective_order() {
        let mut config = HivemindConfig::default_poc();
        config.conversation.reply_order = vec!["Reviewer".into()];
        config.groups.push(config::GroupConfig {
            name: "backend".into(),
            members: vec!["Engineer".into(), "Reviewer".into()],
            mode: config::ConversationMode::Broadcast,
            member_roles: Default::default(),
            reply_order: Default::default(),
        });
        assert_eq!(
            render_group(&config, "backend").unwrap(),
            "Group: backend\nMembers:\n  1. Reviewer [pi]\n  2. Engineer [pi]\n\n\
             Effective reply order:\n  1. Reviewer\n  2. Engineer\n"
        );
    }
    #[tokio::test]
    async fn cli_group_role_override_reaches_context_pack() {
        let fake = FakePi::new();
        let config_path = fake.directory.0.join("hivemind.toml");
        let mut config = fake.config();
        config.groups.push(hivemind::config::GroupConfig {
            name: "review".into(),
            members: vec!["Reviewer".into()],
            mode: ConversationMode::Discussion,
            member_roles: [("Reviewer".into(), "Lead Reviewer".into())]
                .into_iter()
                .collect(),
            reply_order: vec!["Reviewer".into()],
        });
        let core = HivemindCore::new(config.clone(), &config_path).unwrap();
        let replies = route_turn(&core, &Route::Group("review".into()), "review this change")
            .await
            .unwrap();
        core.shutdown().await;
        assert_eq!(replies.replies.len(), 1);
        assert_eq!(replies.replies[0].0, "Reviewer");
        assert!(replies.replies[0]
            .1
            .as_ref()
            .unwrap()
            .contains("Reviewer reply"));

        let prompts = fake.prompt_lines();
        assert_eq!(prompts.len(), 1);
        assert!(prompts[0].contains("You are Reviewer. Your room role is Lead Reviewer."));
    }

    #[tokio::test]
    async fn cli_and_api_agent_listings_match_the_core_registry() {
        let directory =
            std::env::temp_dir().join(format!("hivemind-cli-listing-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let mut config = HivemindConfig::default_poc();
        config.conversation.reply_order = vec!["Reviewer".into(), "Engineer".into()];
        let core = HivemindCore::new(config, directory.join("hivemind.toml")).unwrap();
        let registry = core
            .agents()
            .list()
            .into_iter()
            .map(|agent| agent.name)
            .collect::<Vec<_>>();
        let core_config = core.config();
        let cli = effective_agents(&core_config)
            .into_iter()
            .map(|agent| agent.name.clone())
            .collect::<Vec<_>>();
        assert_eq!(registry, ["Reviewer", "Engineer"]);
        assert_eq!(cli, registry);
        assert_eq!(route_names(&core, &Route::Main).unwrap(), registry);
        core.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn cli_keeps_one_runtime_per_room_instance_and_sends_deltas() {
        let fake = FakePi::new();
        let mut config = fake.config();
        config.groups.push(hivemind::config::GroupConfig {
            name: "review".into(),
            members: vec!["Reviewer".into()],
            mode: ConversationMode::Discussion,
            member_roles: [("Reviewer".into(), "Lead Reviewer".into())]
                .into_iter()
                .collect(),
            reply_order: vec!["Reviewer".into()],
        });
        let config_path = fake.directory.0.join("hivemind.toml");
        let core = HivemindCore::new(config.clone(), &config_path).unwrap();

        for (route, input) in [
            (
                Route::Group("review".into()),
                "Goal: group objective\nfirst group turn",
            ),
            (Route::Solo("Reviewer".into()), "solo route turn"),
            (Route::Solo("Reviewer".into()), "ask turn"),
            (Route::Main, "all turn"),
            (Route::Group("review".into()), "follow-up group turn"),
        ] {
            let replies = route_turn(&core, &route, input).await.unwrap();
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
        for (agent, started, prompts) in [("Reviewer", 3, 5), ("Engineer", 1, 1)] {
            assert_eq!(count(agent, "started"), started, "{lifecycle:?}");
            assert_eq!(count(agent, "prompt"), prompts, "{lifecycle:?}");
            assert_eq!(count(agent, "stopped"), started, "{lifecycle:?}");
        }

        let prompts = fake.prompt_lines();
        assert_eq!(prompts.len(), 6);
        assert!(prompts[0].contains("Lead Reviewer"));
        assert!(prompts[1].contains("solo route turn"));
        assert!(!prompts[1].contains("group objective"));
        // The second group turn continues the live session: a delta that
        // carries only what that session has not seen.
        assert!(prompts[5].contains("follow-up group turn"));
        assert!(prompts[5].contains("Shared room state"));
        assert!(prompts[5].contains("group objective"));
        assert!(!prompts[5].contains("Participants:"));
        assert!(!prompts[5].contains("You are participating in"));
        assert!(!prompts[5].contains("Recent conversation:"));
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
        assert!(commands::ordered_group_members(&config, "empty")
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn active_group_empty_turns_reject_and_delete_routes_to_main() {
        let directory = TestDirectory::new("active-group");
        let path = directory.0.join("config.toml");
        let mut config = HivemindConfig::default_poc();
        std::fs::write(&path, toml::to_string_pretty(&config).unwrap()).unwrap();
        let core = HivemindCore::new(config.clone(), &path).unwrap();
        mutate_group_and_reload(
            &mut config,
            &path,
            Some(&core),
            GroupCommand::Create {
                name: "backend".into(),
                agents: vec!["Reviewer".into()],
            },
        )
        .unwrap();
        let mut route = Route::Group("backend".into());
        mutate_group_and_reload(
            &mut config,
            &path,
            Some(&core),
            GroupCommand::Remove {
                name: "backend".into(),
                agent: "Reviewer".into(),
            },
        )
        .unwrap();
        assert!(route_names(&core, &route)
            .unwrap_err()
            .to_string()
            .contains("has no members"));
        delete_group(&mut config, &path, &core, &mut route, "backend").unwrap();
        assert_eq!(route, Route::Main);
        assert!(HivemindConfig::load(&path).unwrap().groups.is_empty());
        core.shutdown().await;
    }

    #[tokio::test]
    async fn ask_starts_only_its_agent_and_all_orders_output() {
        let fake = FakePi::new();
        let mut config = fake.config();
        config.conversation.reply_order = vec!["Reviewer".into(), "Engineer".into()];
        config.agents[0].runtime = "unrelated-invalid-runtime".into();
        config.agents[0].workspace = "/missing/unrelated/workspace".into();
        let config_path = fake.directory.0.join("hivemind.toml");

        let core = HivemindCore::new(config.clone(), &config_path).unwrap();
        route_turn(&core, &Route::Solo("Missing".into()), "hello")
            .await
            .unwrap_err();
        assert!(fake.log_lines().is_empty());
        let ask_replies = route_turn(&core, &Route::Solo("Reviewer".into()), "targeted")
            .await
            .unwrap();
        let (ask_output, ask_failed) = capture_replies(&ask_replies);
        assert_eq!(ask_output, "\nReviewer> Reviewer reply\n");
        assert!(!ask_failed);
        core.shutdown().await;
        assert_eq!(
            fake.log_lines(),
            ["Reviewer started", "Reviewer prompt", "Reviewer stopped"]
        );

        config.agents[0].runtime = "pi".into();
        config.agents[0].workspace = fake.directory.0.display().to_string();
        fs::write(&fake.log, "").unwrap();
        let core = HivemindCore::new(config.clone(), &config_path).unwrap();
        let all_replies = route_turn(&core, &Route::Main, "broadcast prompt")
            .await
            .unwrap();
        core.shutdown().await;
        let (all_output, all_failed) = capture_replies(&all_replies);
        assert_eq!(
            all_output,
            "\nReviewer> Reviewer reply\n\nEngineer> Engineer reply\n"
        );
        assert!(!all_failed);
        let log = fake.log_lines();
        for event in [
            "Reviewer started",
            "Reviewer prompt",
            "Reviewer stopped",
            "Engineer started",
            "Engineer prompt",
            "Engineer stopped",
        ] {
            assert!(
                log.iter().any(|line| line == event),
                "missing {event} in {log:?}"
            );
        }
        assert_eq!(log.len(), 6);
    }
    #[tokio::test]
    async fn all_cli_target_matches_core_main_resolution_and_order() {
        let fake = FakePi::new();
        let mut config = fake.config();
        config.conversation.reply_order = vec!["Reviewer".into(), "Engineer".into()];
        let core = HivemindCore::new(config, fake.directory.0.join("hivemind.toml")).unwrap();
        let resolved = core.resolve_target(&ConversationTarget::Main).unwrap();
        let expected: Vec<String> = resolved
            .participants
            .iter()
            .map(|participant| participant.agent.name.clone())
            .collect();

        let replies = route_turn(&core, &Route::Main, "equivalence smoke")
            .await
            .unwrap();
        let actual: Vec<String> = replies
            .replies
            .iter()
            .map(|(name, _)| name.clone())
            .collect();
        assert_eq!(actual, expected);
        assert_eq!(actual, ["Reviewer", "Engineer"]);
        assert!(replies.replies.iter().all(|(_, result)| result.is_ok()));
        core.shutdown().await;
    }
}
