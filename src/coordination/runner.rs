//! Durable scheduler: claims attempts from the service, executes each as a
//! turn in its task room, and reports how it ended. Requires a long-lived
//! core (`serve` or `task run`); it is not a background daemon.
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::Result;
use async_trait::async_trait;
use parking_lot::Mutex;
use tokio::task::{AbortHandle, Id, JoinSet};

use super::{
    capsule::build_prompt,
    model::*,
    service::{AttemptEnd, CoordinationService, Dispatch},
    workspace::{self, Finished, Worktree},
};
use crate::{
    config::ConversationMode,
    conversation::{AgentInvoker, Participant},
    core::{HivemindCore, ResolvedConversationTarget},
    identity::AgentInstanceId,
    runtime::{InvokeReply, InvokeRequest, SessionCursor},
};

/// Delegating invoker that remembers the runtime epoch of the last reply, so
/// an attempt can record which live session served it.
struct EpochRecorder {
    inner: Arc<dyn AgentInvoker>,
    epoch: Mutex<Option<String>>,
}

#[async_trait]
impl AgentInvoker for EpochRecorder {
    async fn cursor(&self, agent_instance_id: &AgentInstanceId) -> Option<SessionCursor> {
        self.inner.cursor(agent_instance_id).await
    }

    async fn invoke(&self, request: InvokeRequest<'_>) -> Result<InvokeReply> {
        let reply = self.inner.invoke(request).await?;
        *self.epoch.lock() = Some(reply.epoch_id.clone());
        Ok(reply)
    }
}

struct Running {
    abort: AbortHandle,
    workspace: String,
    serialized: bool,
}

pub struct Scheduler {
    core: Arc<HivemindCore>,
    service: Arc<CoordinationService>,
    invoker: Option<Arc<dyn AgentInvoker>>,
    running: HashMap<String, Running>,
    ids: HashMap<Id, String>,
    jobs: JoinSet<(String, AttemptEnd)>,
    last_heartbeat: Instant,
    git_cache: Mutex<HashMap<String, bool>>,
}

impl Scheduler {
    /// `invoker` replaces the runtime pool (used with fake agents in tests).
    pub fn new(core: Arc<HivemindCore>, invoker: Option<Arc<dyn AgentInvoker>>) -> Self {
        let service = core.coordination().clone();
        Self {
            core,
            service,
            invoker,
            running: HashMap::new(),
            ids: HashMap::new(),
            jobs: JoinSet::new(),
            last_heartbeat: Instant::now(),
            git_cache: Mutex::new(HashMap::new()),
        }
    }

    fn is_git(&self, workspace: &str) -> bool {
        *self
            .git_cache
            .lock()
            .entry(workspace.to_owned())
            .or_insert_with(|| workspace::is_git(workspace))
    }

    /// Nothing can be running after a restart: interrupt leftovers so their
    /// tasks surface as blocked instead of appearing to progress.
    pub fn recover_startup(&self) {
        match self.service.interrupt_orphans(&HashSet::new(), true) {
            Ok(0) => {}
            Ok(count) => eprintln!(
                "coordination: interrupted {count} attempt(s) left running by a previous process"
            ),
            Err(error) => eprintln!("coordination: startup recovery failed: {error}"),
        }
        if let Ok(entries) = std::fs::read_dir(self.core.data_dir().join("worktrees")) {
            for entry in entries.flatten() {
                workspace::discard(&entry.path());
            }
        }
    }

    pub async fn run(mut self) {
        self.service.set_scheduler_running(true);
        self.recover_startup();
        let wake = self.service.wake_signal();
        while !self.core.is_shutting_down() {
            if let Err(error) = self.step().await {
                eprintln!("coordination: scheduler step failed: {error}");
            }
            tokio::select! {
                _ = wake.notified() => {}
                _ = tokio::time::sleep(Duration::from_millis(500)) => {}
            }
        }
        self.stop().await;
    }

    /// Abort everything in flight and record it as interrupted.
    pub async fn stop(&mut self) {
        for (attempt, running) in self.running.drain() {
            running.abort.abort();
            let _ = self
                .service
                .finish_attempt(&attempt, AttemptEnd::Interrupted);
        }
        self.jobs.abort_all();
        while self.jobs.join_next().await.is_some() {}
        self.ids.clear();
        self.service.set_scheduler_running(false);
    }

    /// One scheduling pass. Returns how many attempts it started.
    pub async fn step(&mut self) -> Result<usize> {
        self.service.flush();
        while let Some(joined) = self.jobs.try_join_next_with_id() {
            match joined {
                Ok((id, (attempt, end))) => {
                    self.ids.remove(&id);
                    self.running.remove(&attempt);
                    self.service.finish_attempt(&attempt, end)?;
                }
                Err(error) => {
                    if let Some(attempt) = self.ids.remove(&error.id()) {
                        self.running.remove(&attempt);
                        if !error.is_cancelled() {
                            self.service.finish_attempt(
                                &attempt,
                                AttemptEnd::Failed {
                                    class: "panic".into(),
                                    detail: "attempt task panicked".into(),
                                },
                            )?;
                        }
                    }
                }
            }
        }
        for (instance, reason) in self.service.take_rotations() {
            let core = self.core.clone();
            tokio::spawn(async move { core.rotate_instance(&instance, reason).await });
        }
        let db_running: HashSet<String> = self
            .service
            .store()
            .read(|db| db.running_attempts(None))?
            .into_iter()
            .map(|a| a.id)
            .collect();
        let orphaned: Vec<String> = self
            .running
            .keys()
            .filter(|id| !db_running.contains(*id))
            .cloned()
            .collect();
        for attempt in orphaned {
            if let Some(running) = self.running.remove(&attempt) {
                // Cancelled or otherwise ended in the store while its task is still executing.
                running.abort.abort();
                workspace::discard(&worktree_dir(&self.core, &attempt));
            }
        }
        for attempt in self.service.attempts_to_abort()? {
            if let Some(running) = self.running.remove(&attempt) {
                running.abort.abort();
                workspace::discard(&worktree_dir(&self.core, &attempt));
            }
            self.service
                .finish_attempt(&attempt, AttemptEnd::Cancelled)?;
        }
        let lease = self.service.config().lease_secs;
        if self.last_heartbeat.elapsed() >= Duration::from_secs((lease / 3).max(1)) {
            for attempt in self.running.keys() {
                self.service.heartbeat(attempt)?;
            }
            self.last_heartbeat = Instant::now();
        }
        let live: HashSet<String> = self.running.keys().cloned().collect();
        self.service.interrupt_orphans(&live, false)?;

        let capacity = self
            .service
            .config()
            .max_concurrent
            .saturating_sub(self.running.len());
        let busy: HashSet<String> = self
            .running
            .values()
            .filter(|r| r.serialized)
            .map(|r| r.workspace.clone())
            .collect();
        let serialized = |workspace: &str| !self.is_git(workspace);
        let claimed = self.service.claim(capacity, &serialized, &busy)?;
        let count = claimed.len();
        for dispatch in claimed {
            let attempt = dispatch.attempt.id.clone();
            let workspace = dispatch.task.workspace.clone();
            let serialized = dispatch.attempt.kind == AttemptKind::Work && !self.is_git(&workspace);
            let core = self.core.clone();
            let invoker = self.invoker.clone();
            let handle = self.jobs.spawn(async move {
                let end = execute(core, &dispatch, invoker).await;
                (dispatch.attempt.id.clone(), end)
            });
            self.ids.insert(handle.id(), attempt.clone());
            self.running.insert(
                attempt,
                Running {
                    abort: handle,
                    workspace,
                    serialized,
                },
            );
        }
        Ok(count)
    }

    /// Step until nothing is running or claimable (two consecutive idle passes).
    pub async fn drain(&mut self, limit: Duration) -> Result<()> {
        let started = Instant::now();
        let mut idle = 0;
        loop {
            let claimed = self.step().await?;
            if claimed == 0 && self.running.is_empty() {
                idle += 1;
                if idle >= 2 {
                    return Ok(());
                }
            } else {
                idle = 0;
            }
            anyhow::ensure!(
                started.elapsed() < limit,
                "scheduler did not go idle within {limit:?}"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

fn worktree_dir(core: &HivemindCore, attempt: &str) -> PathBuf {
    let dir = core.data_dir().join("worktrees").join(attempt);
    // git runs with `-C <repo>`, so a relative data dir would resolve against the wrong directory
    std::path::absolute(&dir).unwrap_or(dir)
}

/// Latest commit hash recorded on `task`, if any.
fn latest_commit(service: &CoordinationService, task: &str) -> Option<String> {
    service
        .store()
        .read(|db| {
            Ok(db
                .artifacts(task)?
                .into_iter()
                .rev()
                .find(|a| a.kind == "commit")
                .and_then(|a| a.content_hash))
        })
        .ok()
        .flatten()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tokio::task::spawn_blocking(f).await.ok()
}

fn failed(class: &str, detail: impl Into<String>) -> AttemptEnd {
    AttemptEnd::Failed {
        class: class.into(),
        detail: detail.into(),
    }
}

async fn execute(
    core: Arc<HivemindCore>,
    dispatch: &Dispatch,
    invoker: Option<Arc<dyn AgentInvoker>>,
) -> AttemptEnd {
    let service = core.coordination().clone();
    let (task, attempt) = (&dispatch.task, &dispatch.attempt);
    let Some(agent) = core.agents().get(&attempt.persona) else {
        return failed(
            "unknown_persona",
            format!("persona '{}' is not configured", attempt.persona),
        );
    };
    let budget = core
        .config()
        .context
        .context_target_tokens
        .saturating_mul(4)
        / 2;
    let prompt = match build_prompt(&service, dispatch, budget) {
        Ok(Ok(prompt)) => prompt,
        Ok(Err(overflow)) => {
            let _ =
                service.host_transition(&task.id, TaskStatus::NeedsInput, &overflow.to_string());
            return failed("context_overflow", overflow.to_string());
        }
        Err(error) => return failed("prompt", error.to_string()),
    };
    let _ = service.record_attempt_metrics(&attempt.id, &prompt.metrics);

    let mut config = (*agent).clone();
    let mut notes = String::new();
    let mut worktree: Option<Worktree> = None;
    let root_task = service
        .store()
        .read(|db| db.task_or_err(&task.root_id))
        .ok();
    let is_root = root_task.as_ref().is_some_and(|r| r.id == task.id);
    let workspace = task.workspace.clone();
    if blocking({
        let w = workspace.clone();
        move || workspace::is_git(&w)
    })
    .await
    .unwrap_or(false)
    {
        let dir = worktree_dir(&core, &attempt.id);
        let branch = format!("hivemind/{}-{}", task.id, attempt.id);
        let prepared: Option<Result<Worktree>> = match attempt.kind {
            AttemptKind::Work => {
                let shas: Vec<String> = service
                    .store()
                    .read(|db| {
                        Ok(db
                            .prerequisites(&task.id)?
                            .into_iter()
                            .filter_map(|(pre, _)| {
                                db.artifacts(&pre)
                                    .ok()?
                                    .into_iter()
                                    .rev()
                                    .find(|a| a.kind == "commit")
                                    .and_then(|a| a.content_hash)
                            })
                            .collect())
                    })
                    .unwrap_or_default();
                let (w, d, b) = (workspace.clone(), dir.clone(), branch.clone());
                blocking(move || workspace::prepare(&w, &d, &b, &shas))
                    .await
                    .or_else(|| Some(Err(anyhow::anyhow!("worktree task panicked"))))
            }
            AttemptKind::Review if !is_root => match latest_commit(&service, &task.id) {
                Some(sha) => {
                    let (w, d) = (workspace.clone(), dir.clone());
                    blocking(move || workspace::checkout_detached(&w, &d, &sha))
                        .await
                        .or_else(|| Some(Err(anyhow::anyhow!("worktree task panicked"))))
                }
                None => None,
            },
            _ => None,
        };
        match prepared {
            Some(Ok(tree)) => {
                config.workspace = tree.cwd.display().to_string();
                let _ = service.record_attempt_workspace(
                    &attempt.id,
                    Some(&tree.root.display().to_string()),
                    tree.branch.as_deref(),
                );
                notes.push_str(&match attempt.kind {
                    AttemptKind::Work => format!("\nWorkspace: your working directory is an isolated git worktree on branch {}. Hivemind commits your changes when you finish; do not switch branches.\n", tree.branch.as_deref().unwrap_or("")),
                    _ => "\nWorkspace: your working directory is a read-only checkout of the submitted commit; do not modify it.\n".to_owned(),
                });
                if !tree.conflicts.is_empty() {
                    notes.push_str(&format!("Merge conflicts from prerequisite work are in these files and must be resolved (remove all conflict markers): {}\n", tree.conflicts.join(", ")));
                }
                worktree = Some(tree);
            }
            Some(Err(error)) => return failed("workspace", format!("{error:#}")),
            None => {}
        }
    }

    let room = task_room(&task.id);
    let role = match attempt.kind {
        AttemptKind::Plan => "coordinator",
        AttemptKind::Work => "owner",
        AttemptKind::Review => "reviewer",
        AttemptKind::Inbox => "recipient",
    };
    let target = ResolvedConversationTarget {
        room_id: room.clone(),
        room_name: format!("Task {}", task.id),
        group_id: String::new(),
        mode: ConversationMode::Broadcast,
        participants: vec![Participant {
            agent: Arc::new(config),
            role: Some(role.into()),
        }],
    };
    let recorder = Arc::new(EpochRecorder {
        inner: invoker.unwrap_or_else(|| core.runtime_invoker(&room, "")),
        epoch: Mutex::new(None),
    });
    let message = format!("{}{notes}", prompt.text);
    let outcome = core
        .send_resolved_turn(&target, &message, recorder.clone())
        .await;
    if let Some(epoch) = recorder.epoch.lock().take() {
        let _ = service.record_attempt_epoch(&attempt.id, &epoch);
    }
    let mut end = match outcome {
        Ok(execution) => match execution.replies.into_iter().next() {
            Some(reply) => match reply.result {
                Ok(_) => AttemptEnd::Completed,
                Err(error) => failed("runtime", error),
            },
            None => failed("runtime", "turn produced no reply"),
        },
        Err(error) => failed("turn", format!("{error:#}")),
    };
    if let Some(tree) = worktree {
        let is_work = attempt.kind == AttemptKind::Work;
        let finished = blocking(move || {
            let result = if is_work { Some(tree.finish()) } else { None };
            tree.remove();
            result
        })
        .await
        .flatten();
        if let Some(finished) = finished {
            let branch = format!("hivemind/{}-{}", task.id, attempt.id);
            match finished {
                Ok(Finished::Committed { sha, stat }) => {
                    let _ = service.record_artifact(
                        &task.id,
                        Some(&attempt.id),
                        "commit",
                        &format!("{branch}@{sha}"),
                        Some(&sha),
                        &stat,
                    );
                }
                Ok(Finished::Unchanged) => {}
                Ok(Finished::Unresolved(files)) => {
                    end = failed(
                        "unresolved_conflict",
                        format!("conflict markers remain in: {}", files.join(", ")),
                    );
                }
                Err(error) => end = failed("workspace", format!("{error:#}")),
            }
        }
        // A fresh worktree per attempt means the live session's cwd is gone.
        core.rotate_instance(
            &AgentInstanceId::new(&room, &attempt.persona),
            "attempt_finished",
        )
        .await;
    }
    end
}
