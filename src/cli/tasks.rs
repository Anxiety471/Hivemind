use std::{path::Path, sync::Arc, time::Duration};

use anyhow::{bail, Context, Result};
use hivemind::{
    config::HivemindConfig,
    coordination::{
        model::TaskStatus,
        policy::Plan,
        service::{SubmitTask, TaskDetail},
        store::TaskFilter,
        Scheduler,
    },
    core::HivemindCore,
};

use super::args::TaskCommand;

fn print_detail(detail: &TaskDetail) {
    let task = &detail.task;
    println!("{} [{}] {}", task.id, task.status.as_str(), task.objective);
    if let Some(reason) = &task.status_reason {
        println!("  reason: {reason}");
    }
    println!(
        "  coordinator: {}  owner: {}  reviewer: {}  revision: {}{}",
        task.coordinator,
        task.owner.as_deref().unwrap_or("-"),
        task.reviewer.as_deref().unwrap_or("-"),
        task.revision,
        if task.paused { "  PAUSED" } else { "" }
    );
    for child in &detail.children {
        println!(
            "  - {} [{}] owner={} {}{}",
            child.id,
            child.status.as_str(),
            child.owner.as_deref().unwrap_or("-"),
            child.objective,
            child
                .status_reason
                .as_deref()
                .map(|r| format!(" ({r})"))
                .unwrap_or_default()
        );
    }
    for evidence in &detail.evidence {
        println!(
            "  evidence: {} — {}",
            evidence.check,
            evidence.outcome.as_str()
        );
    }
    if let Some(usage) = &detail.usage {
        println!(
            "  budget: {}/{} dispatches, {}/{} tool actions, {}/{} messages (tokens: unmeasured)",
            usage.dispatches,
            usage.dispatch_limit,
            usage.tool_actions,
            usage.tool_action_limit,
            usage.messages,
            usage.message_limit
        );
    }
}

pub(super) async fn task_command(
    config: HivemindConfig,
    config_path: &Path,
    command: TaskCommand,
) -> Result<()> {
    let core = Arc::new(HivemindCore::new(config, config_path)?);
    let service = core.coordination().clone();
    // Only `task run` serves events; other commands leave them for whoever does.
    if !matches!(command, TaskCommand::Run { .. }) {
        service.set_publish(false);
    }
    let result = match command {
        TaskCommand::Submit {
            objective,
            accept,
            cap,
            workspace,
            plan_file,
            key,
        } => {
            let plan = match plan_file {
                Some(path) => {
                    let raw = std::fs::read_to_string(&path)
                        .with_context(|| format!("reading {}", path.display()))?;
                    Some(
                        serde_json::from_str::<Plan>(&raw)
                            .context("plan file must be {\"tasks\":[...]}")?,
                    )
                }
                None => None,
            };
            let detail = service
                .submit(SubmitTask {
                    objective,
                    acceptance: accept,
                    capabilities: cap,
                    workspace,
                    plan,
                    idempotency_key: key,
                })
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            print_detail(&detail);
            println!("Stored. `hivemind serve` or `hivemind task run` processes stored tasks; `hivemind task watch {}` follows them.", detail.task.id);
            Ok(())
        }
        TaskCommand::List { status } => {
            let status = status
                .map(|s| TaskStatus::parse(&s).with_context(|| format!("unknown status '{s}'")))
                .transpose()?;
            for task in service
                .list_tasks(&TaskFilter {
                    status,
                    roots_only: true,
                    limit: 200,
                    ..Default::default()
                })
                .map_err(|e| anyhow::anyhow!("{e}"))?
            {
                println!(
                    "{} [{}] {}",
                    task.id,
                    task.status.as_str(),
                    task.objective.lines().next().unwrap_or("")
                );
            }
            Ok(())
        }
        TaskCommand::Show { id } => {
            print_detail(&service.detail(&id).map_err(|e| anyhow::anyhow!("{e}"))?);
            Ok(())
        }
        TaskCommand::Cancel { id } => {
            print_detail(
                &service
                    .cancel(&id, "user")
                    .map_err(|e| anyhow::anyhow!("{e}"))?,
            );
            Ok(())
        }
        TaskCommand::Pause { id } => {
            print_detail(
                &service
                    .pause(&id, "user")
                    .map_err(|e| anyhow::anyhow!("{e}"))?,
            );
            Ok(())
        }
        TaskCommand::Resume { id, retry } => {
            print_detail(
                &service
                    .resume(&id, retry, 0, 0, "user")
                    .map_err(|e| anyhow::anyhow!("{e}"))?,
            );
            Ok(())
        }
        TaskCommand::Watch { id, poll_ms } => watch(&core, &id, poll_ms).await,
        TaskCommand::Run { until_idle } => {
            if !service.enabled() {
                bail!("coordination is disabled; set coordination.enabled = true in the config");
            }
            let mut scheduler = Scheduler::new(core.clone(), None);
            if until_idle {
                scheduler.recover_startup();
                scheduler.drain(Duration::from_secs(24 * 3600)).await?;
                scheduler.stop().await;
                println!("No claimable work remains.");
            } else {
                println!("Running the coordination scheduler; Ctrl-C stops it (running attempts are recorded as interrupted).");
                let handle = tokio::spawn(scheduler.run());
                let _ = tokio::signal::ctrl_c().await;
                core.shutdown().await;
                let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
            }
            Ok(())
        }
    };
    core.shutdown().await;
    result
}

/// Follow a task's durable events. Ctrl-C only stops watching; it never cancels the task.
async fn watch(core: &HivemindCore, id: &str, poll_ms: u64) -> Result<()> {
    let service = core.coordination();
    let root = service
        .detail(id)
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .task
        .root_id;
    let mut after = 0;
    loop {
        let (events, _) = service
            .events_after(after, Some(&root), 200)
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        for event in &events {
            println!(
                "{:>5} {} {} {}",
                event.seq, event.event_type, event.actor, event.payload
            );
            after = event.seq;
        }
        if events.is_empty() {
            let detail = service.detail(&root).map_err(|e| anyhow::anyhow!("{e}"))?;
            if detail.task.status.is_terminal() {
                println!("Task {} is {}.", root, detail.task.status.as_str());
                return Ok(());
            }
            tokio::select! {
                _ = tokio::signal::ctrl_c() => { println!("Stopped watching; the task keeps running."); return Ok(()); }
                _ = tokio::time::sleep(Duration::from_millis(poll_ms.max(100))) => {}
            }
        }
    }
}
