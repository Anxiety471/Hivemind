//! Task-thread handoff.
//!
//! Chat sessions (main, solo, group, `ask`, `all`) are launched read-only, so
//! an agent that wants to change the workspace calls `task.delegate`. Hivemind
//! then runs the work in its own room (`task/<id>`) with a worker session that
//! has full tools, and posts the worker's final report back into the room that
//! asked. The worker never sees the originating conversation and cannot
//! delegate further; the asking agent never waits on it.
//!
//! The registry is process-local. Each thread's transcript and the posted
//! report are durable in the room archive, but a task that is still running
//! when the core shuts down is cancelled and is not resumed.
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
use serde::Serialize;
use tokio::{sync::Notify, task::AbortHandle};

use crate::{
    config::{AgentConfig, ConversationMode, HivemindConfig},
    conversation::{ConversationCoordinator, Participant, RuntimeInvoker, TurnRequest},
    events::{DomainEventKind, EventBus},
    memory::Caller,
    runtime::RuntimePool,
};

/// Room-id prefix reserved for task threads; chat routes never produce it.
pub const TASK_ROOM_PREFIX: &str = "task/";
/// Largest brief an agent may hand off.
pub const MAX_BRIEF_BYTES: usize = 8_000;
/// Largest worker report posted back into the originating room.
pub const MAX_REPORT_BYTES: usize = 4_000;
const BRIEF_PREVIEW_BYTES: usize = 200;

pub fn is_task_room(room: &str) -> bool {
    room.starts_with(TASK_ROOM_PREFIX)
}

/// Starts task threads on behalf of an agent. `caller` is the host-built
/// identity of the delegating agent, never anything the model supplied.
#[async_trait]
pub trait TaskDelegator: Send + Sync {
    async fn delegate(&self, caller: &Caller, worker: Option<&str>, brief: &str) -> Result<String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TaskRecord {
    pub id: String,
    /// Room that asked for the work and receives the report.
    pub room_id: String,
    pub requested_by: String,
    pub worker: String,
    pub thread_room_id: String,
    pub brief: String,
    pub status: TaskStatus,
    /// Worker report on success, or the failure reason.
    pub report: Option<String>,
}

struct Inner {
    config: Arc<HivemindConfig>,
    conversation: Arc<ConversationCoordinator>,
    runtime: Arc<RuntimePool>,
    events: EventBus,
    records: Mutex<Vec<TaskRecord>>,
    aborts: Mutex<HashMap<String, AbortHandle>>,
    idle: Notify,
    closed: AtomicBool,
    sequence: AtomicU64,
}

#[derive(Clone)]
pub struct TaskService {
    inner: Arc<Inner>,
}

impl TaskService {
    pub fn new(
        config: Arc<HivemindConfig>,
        conversation: Arc<ConversationCoordinator>,
        runtime: Arc<RuntimePool>,
        events: EventBus,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                conversation,
                runtime,
                events,
                records: Mutex::new(Vec::new()),
                aborts: Mutex::new(HashMap::new()),
                idle: Notify::new(),
                closed: AtomicBool::new(false),
                sequence: AtomicU64::new(0),
            }),
        }
    }

    /// Every task started by this core, oldest first.
    pub fn list(&self) -> Vec<TaskRecord> {
        self.inner.records.lock().expect("task records").clone()
    }

    pub fn get(&self, id: &str) -> Option<TaskRecord> {
        self.list().into_iter().find(|record| record.id == id)
    }

    /// Resolve once no task is running. Used by one-shot commands so a
    /// handoff is not cancelled the moment their turn returns.
    pub async fn wait_idle(&self) {
        loop {
            let notified = self.inner.idle.notified();
            if self.inner.running() == 0 {
                return;
            }
            notified.await;
        }
    }

    /// Refuse new tasks and cancel every running one.
    pub fn cancel_all(&self) {
        let inner = &self.inner;
        inner.closed.store(true, Ordering::Release);
        for (_, abort) in inner.aborts.lock().expect("task aborts").drain() {
            abort.abort();
        }
        let cancelled: Vec<TaskRecord> = {
            let mut records = inner.records.lock().expect("task records");
            records
                .iter_mut()
                .filter(|record| record.status == TaskStatus::Running)
                .map(|record| {
                    record.status = TaskStatus::Cancelled;
                    record.clone()
                })
                .collect()
        };
        for record in cancelled {
            inner.events.publish(DomainEventKind::TaskCancelled {
                task_id: record.id,
                room_id: record.room_id,
                thread_room_id: record.thread_room_id,
                worker: record.worker,
            });
        }
        inner.idle.notify_waiters();
    }
}

#[async_trait]
impl TaskDelegator for TaskService {
    async fn delegate(&self, caller: &Caller, worker: Option<&str>, brief: &str) -> Result<String> {
        let inner = &self.inner;
        if inner.closed.load(Ordering::Acquire) {
            bail!("Hivemind is shutting down; no new task threads can start");
        }
        if is_task_room(&caller.room_id) {
            bail!("task threads cannot delegate further work");
        }
        let brief = brief.trim();
        if brief.is_empty() {
            bail!("task brief must not be empty");
        }
        if brief.len() > MAX_BRIEF_BYTES {
            bail!(
                "task brief is {} bytes; the limit is {MAX_BRIEF_BYTES}. Summarize it and put long material in a file the worker can read",
                brief.len()
            );
        }
        let worker_name = worker
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(&caller.persona_id);
        let agent = inner
            .config
            .agents
            .iter()
            .find(|agent| agent.name == worker_name)
            .cloned()
            .ok_or_else(|| {
                let known = inner
                    .config
                    .agents
                    .iter()
                    .map(|agent| agent.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                anyhow!("unknown worker persona '{worker_name}'; configured personas: {known}")
            })?;

        let id = format!(
            "task-{:x}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            inner.sequence.fetch_add(1, Ordering::Relaxed) + 1
        );
        let thread = format!("{TASK_ROOM_PREFIX}{id}");
        let record = TaskRecord {
            id: id.clone(),
            room_id: caller.room_id.clone(),
            requested_by: caller.persona_id.clone(),
            worker: agent.name.clone(),
            thread_room_id: thread.clone(),
            brief: preview(brief),
            status: TaskStatus::Running,
            report: None,
        };
        {
            let mut records = inner.records.lock().expect("task records");
            let limit = inner.config.tasks.max_concurrent;
            let running = records
                .iter()
                .filter(|record| record.status == TaskStatus::Running)
                .count();
            if running >= limit {
                bail!(
                    "{running} task threads are already running (limit {limit}); finish this work yourself in plain text or tell the user to retry after one completes"
                );
            }
            records.push(record);
        }
        inner.events.publish(DomainEventKind::TaskStarted {
            task_id: id.clone(),
            room_id: caller.room_id.clone(),
            thread_room_id: thread.clone(),
            requested_by: caller.persona_id.clone(),
            worker: agent.name.clone(),
        });
        let handle = tokio::spawn(run_task(
            inner.clone(),
            id.clone(),
            agent.clone(),
            caller.room_id.clone(),
            caller.persona_id.clone(),
            brief.to_owned(),
        ));
        inner
            .aborts
            .lock()
            .expect("task aborts")
            .insert(id.clone(), handle.abort_handle());
        Ok(format!(
            "task {id} started: {} is working on it in thread {thread} with full workspace tools. Tell the user what you handed off and stop; Hivemind posts the worker's final report into this room when it finishes. Do not wait for it, poll, or guess its outcome.",
            agent.name
        ))
    }
}

impl Inner {
    fn running(&self) -> usize {
        self.records
            .lock()
            .expect("task records")
            .iter()
            .filter(|record| record.status == TaskStatus::Running)
            .count()
    }

    /// Post the report into the originating room first, then flip the status,
    /// so `wait_idle` only resolves after the report is durable.
    async fn finish(
        &self,
        id: &str,
        room_id: &str,
        thread: &str,
        worker: &str,
        result: Result<String, String>,
    ) {
        let (status, body, message) = match &result {
            Ok(text) => (
                TaskStatus::Completed,
                bound_report(text),
                format!(
                    "Task {id} completed by {worker} in thread {thread}.\n\n{}",
                    bound_report(text)
                ),
            ),
            Err(error) => (
                TaskStatus::Failed,
                bound_report(error),
                format!(
                    "Task {id} failed ({worker}, thread {thread}): {}",
                    bound_report(error)
                ),
            ),
        };
        if let Err(error) = self
            .conversation
            .post_report(room_id, &format!("task:{id}"), &message)
            .await
        {
            eprintln!("warning: failed to post report for {id} into '{room_id}': {error:#}");
        }
        self.aborts.lock().expect("task aborts").remove(id);
        let finished = {
            let mut records = self.records.lock().expect("task records");
            records
                .iter_mut()
                .find(|record| record.id == id && record.status == TaskStatus::Running)
                .map(|record| {
                    record.status = status;
                    record.report = Some(body.clone());
                })
                .is_some()
        };
        if finished {
            self.events.publish(match status {
                TaskStatus::Completed => DomainEventKind::TaskCompleted {
                    task_id: id.to_owned(),
                    room_id: room_id.to_owned(),
                    thread_room_id: thread.to_owned(),
                    worker: worker.to_owned(),
                },
                _ => DomainEventKind::TaskFailed {
                    task_id: id.to_owned(),
                    room_id: room_id.to_owned(),
                    thread_room_id: thread.to_owned(),
                    worker: worker.to_owned(),
                    message: body,
                },
            });
        }
        self.idle.notify_waiters();
    }
}

async fn run_task(
    inner: Arc<Inner>,
    id: String,
    agent: AgentConfig,
    room_id: String,
    requested_by: String,
    brief: String,
) {
    let thread = format!("{TASK_ROOM_PREFIX}{id}");
    let members = [Participant {
        agent: agent.clone(),
        role: Some("Task worker".into()),
    }];
    let invoker = Arc::new(RuntimeInvoker::task_worker(inner.runtime.clone(), &thread));
    let input = worker_input(&id, &room_id, &requested_by, &brief);
    let outcome = inner
        .conversation
        .turn(TurnRequest {
            room: &thread,
            room_name: &thread,
            group_id: "",
            mode: ConversationMode::Broadcast,
            members: &members,
            input: &input,
            invoker,
        })
        .await;
    let result = match outcome {
        Ok(mut replies) => match replies.pop() {
            Some(reply) => reply.result,
            None => Err("the worker produced no reply".to_owned()),
        },
        Err(error) => Err(format!("{error:#}")),
    };
    inner
        .finish(&id, &room_id, &thread, &agent.name, result)
        .await;
}

fn worker_input(id: &str, room_id: &str, requested_by: &str, brief: &str) -> String {
    format!(
        "You are the worker for task {id}, handed off from room '{room_id}' by {requested_by}. \
You have full workspace tools in this isolated thread; you cannot see the originating conversation, so the brief below is everything you were given.\n\
Do the work, check it, then reply with one concise final report: what you changed, how you verified it, and anything unresolved. \
Your reply is posted back to the originating room. Nobody can answer questions mid-task, so state any assumption you made instead of asking.\n\n\
Task brief:\n{brief}"
    )
}

fn preview(text: &str) -> String {
    truncate(text, BRIEF_PREVIEW_BYTES)
}

fn bound_report(text: &str) -> String {
    let text = text.trim();
    if text.len() <= MAX_REPORT_BYTES {
        return text.to_owned();
    }
    format!(
        "{}\n[report truncated; the full transcript is in the task thread]",
        truncate(text, MAX_REPORT_BYTES)
    )
}

fn truncate(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_owned();
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::{Path, PathBuf},
        sync::atomic::AtomicUsize,
    };

    use super::*;
    use crate::{
        core::{CoreTurnRequest, HivemindCore},
        events::DomainEventKind,
    };

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Dir(PathBuf);
    impl Dir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "hivemind-tasks-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Fake Pi. It logs the flags it was launched with and every prompt, then:
    /// a prompt carrying a task brief is the worker and reports back (slowly
    /// while `slow` exists); a tool result is answered in plain text; any other
    /// prompt delegates unless `plain` exists.
    fn core_with_fake_pi(dir: &Dir, max_concurrent: usize) -> HivemindCore {
        let binary = dir.path("fake-pi");
        let script = r#"#!/bin/sh
printf '%s\n' "$*" >> __DIR__/args.log
while IFS= read -r request; do
  case "$request" in
    *'"type":"new_session"'*)
      printf '%s\n' '{"type":"response","command":"new_session","success":true}' ;;
    *'"type":"get_session_stats"'*)
      printf '%s\n' '{"type":"response","command":"get_session_stats","success":true,"data":{}}' ;;
    *'"type":"prompt"'*)
      printf '%s\n' "$request" >> __DIR__/prompts.log
      if printf '%s' "$request" | grep -q 'Task brief:'; then
        [ -e __DIR__/slow ] && sleep 3
        printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"worker report: done"}]}}'
      elif printf '%s' "$request" | grep -q 'Memory tool result:'; then
        printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Handed off."}]}}'
      elif [ -e __DIR__/plain ]; then
        printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"plain answer"}]}}'
      else
        printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"```hivemind-tool\n{\"name\":\"task.delegate\",\"args\":{\"brief\":\"edit README\"}}\n```"}]}}'
      fi
      printf '%s\n' '{"type":"agent_settled"}' ;;
  esac
done
"#
        .replace("__DIR__", &format!("'{}'", dir.0.display()));
        fs::write(&binary, script).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();

        let mut config = HivemindConfig::default_poc();
        config.agents.retain(|agent| agent.name == "Maomao");
        config.agents[0].workspace = dir.0.display().to_string();
        config.runtime.pi_binary = binary.display().to_string();
        config.tasks.max_concurrent = max_concurrent;
        HivemindCore::new(config, dir.path("hivemind.toml")).unwrap()
    }

    fn lines(path: &Path) -> Vec<String> {
        fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    async fn solo_turn(core: &HivemindCore, room: &str, input: &str) -> Vec<String> {
        let members = [Participant {
            agent: core.agents().list()[0].clone(),
            role: None,
        }];
        core.turn(CoreTurnRequest {
            room,
            room_name: room,
            group_id: "",
            mode: ConversationMode::Broadcast,
            members: &members,
            input,
        })
        .await
        .unwrap()
        .into_iter()
        .map(|reply| reply.result.unwrap_or_else(|error| format!("ERR {error}")))
        .collect()
    }

    fn chat_caller(room: &str) -> Caller {
        Caller::agent(room, "", format!("{room}/Maomao"), "Maomao", "Maomao")
    }

    #[tokio::test]
    async fn chat_is_read_only_and_edits_go_to_a_task_thread_that_reports_back() {
        let dir = Dir::new();
        let core = core_with_fake_pi(&dir, 4);
        let mut events = core.events().subscribe();

        let replies = solo_turn(&core, "solo-Maomao", "please edit the README").await;
        assert_eq!(replies, ["Handed off."]);
        core.tasks().wait_idle().await;

        let tasks = core.tasks().list();
        assert_eq!(tasks.len(), 1);
        let task = &tasks[0];
        assert_eq!(task.status, TaskStatus::Completed);
        assert_eq!(task.report.as_deref(), Some("worker report: done"));
        assert_eq!(task.room_id, "solo-Maomao");
        assert_eq!(task.worker, "Maomao");
        assert!(is_task_room(&task.thread_room_id));

        // The chat session was launched read-only; the worker's was not.
        let launches = lines(&dir.path("args.log"));
        assert_eq!(launches.len(), 2, "{launches:?}");
        assert!(
            launches[0].contains("--tools read,grep,find,ls"),
            "{}",
            launches[0]
        );
        assert!(!launches[1].contains("--tools"), "{}", launches[1]);

        // The worker saw the brief in its own thread, not the chat.
        let thread = core
            .conversation()
            .room_history(&task.thread_room_id)
            .unwrap();
        assert!(thread.events[0]
            .content
            .contains("Task brief:\nedit README"));
        assert!(!thread.events[0].content.contains("please edit the README"));

        // The report landed in the originating room as its own turn.
        let room = core.conversation().room_history("solo-Maomao").unwrap();
        let report = room.events.last().unwrap();
        assert_eq!(report.speaker, format!("task:{}", task.id));
        assert!(report.content.contains("completed by Maomao"));
        assert!(report.content.contains("worker report: done"));

        // The next chat turn is told about it.
        fs::write(dir.path("plain"), "").unwrap();
        assert_eq!(
            solo_turn(&core, "solo-Maomao", "what happened?").await,
            ["plain answer"]
        );
        let prompts = lines(&dir.path("prompts.log"));
        assert!(
            prompts.last().unwrap().contains("worker report: done"),
            "{}",
            prompts.last().unwrap()
        );

        let mut seen = Vec::new();
        while let Ok(event) = events.try_recv() {
            match event.payload {
                DomainEventKind::TaskStarted { task_id, .. } => seen.push(("started", task_id)),
                DomainEventKind::TaskCompleted { task_id, .. } => seen.push(("completed", task_id)),
                _ => {}
            }
        }
        assert_eq!(
            seen,
            [("started", task.id.clone()), ("completed", task.id.clone())]
        );
        core.shutdown().await;
    }

    #[tokio::test]
    async fn delegation_is_validated_and_workers_cannot_delegate() {
        let dir = Dir::new();
        let core = core_with_fake_pi(&dir, 4);
        let tasks = core.tasks();
        let caller = chat_caller("solo-Maomao");

        let error = tasks.delegate(&caller, None, "   ").await.unwrap_err();
        assert!(error.to_string().contains("must not be empty"), "{error}");
        let error = tasks
            .delegate(&caller, None, &"x".repeat(MAX_BRIEF_BYTES + 1))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("limit"), "{error}");
        let error = tasks
            .delegate(&caller, Some("Nobody"), "do it")
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("configured personas: Maomao"),
            "{error}"
        );
        let worker = Caller::agent("task/task-1", "", "task/task-1/Maomao", "Maomao", "Maomao");
        let error = tasks.delegate(&worker, None, "do it").await.unwrap_err();
        assert!(error.to_string().contains("cannot delegate"), "{error}");
        assert!(tasks.list().is_empty());
        core.shutdown().await;
    }

    #[tokio::test]
    async fn concurrency_is_capped_and_shutdown_cancels_running_threads() {
        let dir = Dir::new();
        fs::write(dir.path("slow"), "").unwrap();
        let core = core_with_fake_pi(&dir, 1);
        let mut events = core.events().subscribe();
        let caller = chat_caller("solo-Maomao");

        core.tasks().delegate(&caller, None, "first").await.unwrap();
        let error = core
            .tasks()
            .delegate(&caller, None, "second")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("limit 1"), "{error}");

        core.shutdown().await;
        let tasks = core.tasks().list();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].status, TaskStatus::Cancelled);
        let error = core
            .tasks()
            .delegate(&caller, None, "late")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("shutting down"), "{error}");
        core.tasks().wait_idle().await;

        let mut cancelled = 0;
        while let Ok(event) = events.try_recv() {
            if matches!(event.payload, DomainEventKind::TaskCancelled { .. }) {
                cancelled += 1;
            }
        }
        assert_eq!(cancelled, 1);
    }
}
