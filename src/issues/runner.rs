//! Runs one discussion in the issues room, and starts one when the user's
//! cadence says it is due. The model files issues; it does not implement them.
use std::{sync::Arc, time::Duration};

use anyhow::Result;

use super::{
    model::*,
    service::resolve_members,
};
use crate::{
    config::ConversationMode,
    conversation::{AgentInvoker, Participant},
    core::{CoreTurnRequest, HivemindCore},
};

pub struct Scheduler {
    core: Arc<HivemindCore>,
    idle_since: Option<i64>,
    last_error: Option<String>,
}

impl Scheduler {
    pub fn new(core: Arc<HivemindCore>) -> Self {
        Self {
            core,
            idle_since: None,
            last_error: None,
        }
    }

    pub async fn run(mut self) {
        match self.core.issues().interrupt_running() {
            Ok(0) => {}
            Ok(count) => eprintln!(
                "issues: interrupted {count} council(s) left running by a previous process"
            ),
            Err(error) => eprintln!("issues: startup recovery failed: {error}"),
        }
        while !self.core.is_shutting_down() {
            if let Err(error) = self.step().await {
                let message = error.to_string();
                if self.last_error.as_deref() != Some(message.as_str()) {
                    eprintln!("issues: {message}");
                    self.last_error = Some(message);
                }
            } else {
                self.last_error = None;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    async fn step(&mut self) -> Result<()> {
        let settings = self.core.issues().config();
        if !settings.enabled {
            self.idle_since = None;
            return Ok(());
        }
        if self.core.issues().running()?.is_some() {
            return Ok(());
        }
        let now = self.core.issues().now();
        let busy = hive_busy(&self.core);
        if busy {
            self.idle_since = None;
        } else if self.idle_since.is_none() {
            self.idle_since = Some(now);
        }
        let anchor = self.core.issues().anchor(now)?;
        let Some(trigger) = pace_due(Pace {
            mode: settings.mode,
            interval_secs: settings.interval_secs,
            idle_secs: settings.idle_secs,
            now,
            anchor,
            idle_since: self.idle_since,
            busy,
            round_running: false,
        }) else {
            return Ok(());
        };
        start_council(&self.core, trigger, None).await
    }
}

pub async fn start_council(
    core: &HivemindCore,
    trigger: Trigger,
    invoker: Option<Arc<dyn AgentInvoker>>,
) -> Result<()> {
    let members = resolve_members(&core.config())?;
    let round = core.issues().begin_round(trigger, &members)?;
    run_discussion(core, &round.id, invoker).await
}

pub async fn run_discussion(
    core: &HivemindCore,
    round_id: &str,
    invoker: Option<Arc<dyn AgentInvoker>>,
) -> Result<()> {
    let outcome = discussion(core, round_id, invoker).await;
    if let Err(error) = &outcome {
        eprintln!("issues: council {round_id} failed: {error:#}");
    }
    outcome
}

async fn discussion(
    core: &HivemindCore,
    round_id: &str,
    invoker: Option<Arc<dyn AgentInvoker>>,
) -> Result<()> {
    let round = core.issues().round(round_id)?;
    let members = participants(core, &round.members);
    if members.is_empty() {
        core.issues()
            .finish_round(round_id, Some("no council members are still configured".into()))?;
        anyhow::bail!("no council members are still configured");
    }
    let prompt = core.issues().discussion_prompt()?;
    let invoker = invoker.unwrap_or_else(|| core.runtime_invoker(COUNCIL_ROOM, ""));
    let turn = core
        .turn_with_invoker(
            CoreTurnRequest {
                room: COUNCIL_ROOM,
                room_name: "Issue council",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &members,
                input: &prompt,
            },
            invoker,
        )
        .await;
    match turn {
        Ok(_) => {
            core.issues().finish_round(round_id, None)?;
            Ok(())
        }
        Err(error) => {
            let message = format!("{error:#}");
            core.issues()
                .finish_round(round_id, Some(message.clone()))?;
            Err(error)
        }
    }
}

fn participants(core: &HivemindCore, names: &[String]) -> Vec<Participant> {
    let registry = core.agents();
    names
        .iter()
        .filter_map(|name| {
            let agent = registry.get(name)?;
            let role = agent.role.clone();
            Some(Participant { agent, role })
        })
        .collect()
}

fn hive_busy(core: &HivemindCore) -> bool {
    if core.events().any_active_replies() {
        return true;
    }
    if core.execution().has_active_jobs().unwrap_or(true) {
        return true;
    }
    core.coordination()
        .store()
        .read(|db| db.running_attempts(None))
        .map(|attempts| !attempts.is_empty())
        .unwrap_or(true)
}
