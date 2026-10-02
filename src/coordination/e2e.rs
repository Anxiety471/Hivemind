//! End-to-end: real core, scheduler, tool loop, and git worktrees with a
//! scripted fake agent instead of a model.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::Duration,
};

use anyhow::Result;
use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{json, Value};

use super::{
    model::*,
    service::{SubmitTask, TaskDetail},
    tests::team_config,
    Scheduler,
};
use crate::{
    conversation::AgentInvoker,
    core::HivemindCore,
    identity::AgentInstanceId,
    runtime::{InvokeReply, InvokeRequest, PromptPhase, SessionCursor},
};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@t"])
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

struct Fixture {
    root: PathBuf,
    repo: PathBuf,
    core: Arc<HivemindCore>,
}

impl Fixture {
    fn new(tune: impl FnOnce(&mut crate::config::HivemindConfig)) -> Self {
        let root = std::env::temp_dir().join(format!("hivemind-e2e-{}", new_id("t")));
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("README.md"), "fixture\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let mut config = team_config(&repo.display().to_string());
        tune(&mut config);
        let core = Arc::new(HivemindCore::new(config, root.join("hivemind.toml")).unwrap());
        Self { root, repo, core }
    }

    fn submit(&self, objective: &str) -> TaskDetail {
        self.core
            .coordination()
            .submit(SubmitTask {
                objective: objective.into(),
                acceptance: vec![],
                capabilities: vec![],
                workspace: None,
                plan: None,
                idempotency_key: None,
            })
            .unwrap()
    }

    fn detail(&self, id: &str) -> TaskDetail {
        self.core.coordination().detail(id).unwrap()
    }

    async fn run(&self, invoker: &Arc<Fake>) {
        let mut scheduler = Scheduler::new(
            self.core.clone(),
            Some(invoker.clone() as Arc<dyn AgentInvoker>),
        );
        scheduler.drain(Duration::from_secs(60)).await.unwrap();
        scheduler.stop().await;
    }

    fn child(&self, root: &str, objective: &str) -> TaskDetail {
        let detail = self.detail(root);
        let id = &detail
            .children
            .iter()
            .find(|c| c.objective == objective)
            .unwrap_or_else(|| {
                panic!(
                    "no child '{objective}' in {:?}",
                    detail
                        .children
                        .iter()
                        .map(|c| &c.objective)
                        .collect::<Vec<_>>()
                )
            })
            .id;
        self.detail(id)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[derive(Default, Clone, Copy)]
struct Scenario {
    /// api and ui both edit shared.txt, independently of each other.
    conflict: bool,
    /// The integrator resolves merge conflicts (otherwise it leaves markers).
    resolve: bool,
    /// The ui task depends on api (the contract flows through the capsule).
    ui_after_api: bool,
    /// Backend work never finishes (until cancelled).
    hang_backend: bool,
    /// Backend attempt returns a runtime error.
    fail_backend: bool,
    /// Plan proposes a global memory write from the task text.
    global_probe: bool,
    /// Backend asks the user a blocking question before finishing.
    ask_user: bool,
    defer_user: bool,
}

struct Fake {
    scenario: Scenario,
    steps: Mutex<HashMap<String, usize>>,
    reviews: Mutex<HashMap<String, usize>>,
    /// (persona, role, task objective, full pack) per attempt start.
    starts: Mutex<Vec<(String, String, String, String)>>,
    /// Tool results the agents saw (in-turn follow-ups).
    followups: Mutex<Vec<String>>,
}

impl Fake {
    fn new(scenario: Scenario) -> Arc<Self> {
        Arc::new(Self {
            scenario,
            steps: Mutex::default(),
            reviews: Mutex::default(),
            starts: Mutex::default(),
            followups: Mutex::default(),
        })
    }

    fn starts_of(&self, persona: &str, role: &str) -> Vec<(String, String)> {
        self.starts
            .lock()
            .iter()
            .filter(|(p, r, ..)| p == persona && r == role)
            .map(|(_, _, objective, full)| (objective.clone(), full.clone()))
            .collect()
    }
}

fn tool(name: &str, args: Value) -> String {
    format!(
        "```hivemind-tool\n{}\n```",
        json!({"name": name, "args": args})
    )
}

fn between<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
    let from = text.rfind(start).map(|i| i + start.len()).unwrap_or(0);
    let rest = &text[from..];
    &rest[..rest.find(end).unwrap_or(rest.len())]
}

fn submit_result(summary: &str) -> String {
    tool(
        "tasks.result.submit",
        json!({"summary": summary, "artifacts": [{"kind": "file", "reference": "notes", "description": "what changed"}], "verification": [{"check": "fixture check", "outcome": "passed", "detail": "ok"}]}),
    )
}

#[async_trait]
impl AgentInvoker for Fake {
    async fn cursor(&self, _instance: &AgentInstanceId) -> Option<SessionCursor> {
        None
    }

    async fn invoke(&self, request: InvokeRequest<'_>) -> Result<InvokeReply> {
        let persona = request.agent.name.clone();
        let full = request.full;
        let role = between(full, "Your role: ", ".").to_owned();
        let task = between(full, "generated by Hivemind for task ", ";").to_owned();
        let objective = between(full, "Objective:\n", "\n").to_owned();
        let key = format!("{task}/{persona}/{role}");
        let step = {
            let mut steps = self.steps.lock();
            if request.phase == PromptPhase::TurnStart {
                steps.insert(key.clone(), 0);
                self.starts.lock().push((
                    persona.clone(),
                    role.clone(),
                    objective.clone(),
                    full.to_owned(),
                ));
            } else {
                if let Some(delta) = request.delta {
                    self.followups.lock().push(delta.text.to_owned());
                }
                *steps.entry(key.clone()).or_default() += 1;
            }
            steps[&key]
        };
        let cwd = PathBuf::from(&request.agent.workspace);
        let s = self.scenario;
        let reply = match (persona.as_str(), role.as_str(), step) {
            ("Lead", "plan", 0) if s.global_probe => tool(
                "memory.global.propose",
                json!({"content": "pineapple rules"}),
            ),
            ("Lead", "plan", 0) => {
                let mut ui = json!({"key": "ui", "objective": "implement ui", "acceptance": ["form posts to the api"], "capabilities": ["frontend"]});
                if s.ui_after_api {
                    ui["depends_on"] = json!(["api"]);
                }
                tool(
                    "tasks.plan.propose",
                    json!({"tasks": [
                        {"key": "api", "objective": "implement api", "acceptance": ["endpoint validates input"], "capabilities": ["backend"], "contract": "POST /orders -> 201 {id}; 422 {errors}"},
                        ui,
                        {"key": "merge", "objective": "integrate and verify", "acceptance": ["both changes present"], "kind": "integrate", "depends_on": ["api", "ui"]},
                    ]}),
                )
            }
            ("Back", "work", 0) if s.defer_user => {
                if full.contains("Answer from user to question") {
                    assert_eq!(
                        std::fs::read_to_string(cwd.join("checkpoint.txt")).unwrap(),
                        "saved before waiting"
                    );
                    assert!(full.contains("sqlite"));
                    std::fs::write(cwd.join("api.txt"), "api on sqlite").unwrap();
                    submit_result("continued from checkpoint")
                } else {
                    std::fs::write(cwd.join("checkpoint.txt"), "saved before waiting").unwrap();
                    tool("tasks.wait", json!({"question": "sqlite or postgres?"}))
                }
            }
            ("Back", "work", 0) if s.ask_user => {
                tool("tasks.ask", json!({"question": "sqlite or postgres?"}))
            }
            ("Back", "work", 1) if s.ask_user => {
                let answer = request.delta.map(|d| d.text.to_owned()).unwrap_or_default();
                assert!(answer.contains("answer from user: sqlite"), "{answer}");
                std::fs::write(cwd.join("api.txt"), "api on sqlite\n").unwrap();
                submit_result("api done on sqlite")
            }
            ("Back", "work", 0) => {
                if s.hang_backend {
                    std::future::pending::<()>().await;
                }
                if s.fail_backend {
                    anyhow::bail!("provider exploded");
                }
                std::fs::write(cwd.join("api.txt"), "api\n").unwrap();
                if s.conflict {
                    std::fs::write(cwd.join("shared.txt"), "api version\n").unwrap();
                }
                tool(
                    "messages.send",
                    json!({"to": ["Front"], "kind": "handoff", "handoff": {"changes": "added api.txt", "contract": "POST /orders -> 201 {id}", "verification": "unit tests", "requested_action": "wire the form"}}),
                )
            }
            ("Back", "work", 1) => submit_result("api done"),
            ("Front", "work", 0) => {
                let repaired = full.contains("Feedback: rejected by Lead");
                std::fs::write(
                    cwd.join("ui.txt"),
                    if repaired { "ui v2\n" } else { "ui v1\n" },
                )
                .unwrap();
                if s.conflict {
                    std::fs::write(cwd.join("shared.txt"), "ui version\n").unwrap();
                }
                submit_result("ui done")
            }
            ("Integrator", "work", 0) => {
                if s.conflict {
                    assert!(
                        full.contains("Merge conflicts"),
                        "conflicts are announced to the integrator"
                    );
                    if s.resolve {
                        std::fs::write(cwd.join("shared.txt"), "merged\n").unwrap();
                    }
                } else {
                    assert!(
                        cwd.join("api.txt").exists() && cwd.join("ui.txt").exists(),
                        "prerequisite work is merged into the integrator's worktree"
                    );
                }
                std::fs::write(cwd.join("integration.txt"), "checked\n").unwrap();
                submit_result("integrated")
            }
            ("Lead", "review", 0) => {
                let mut reviews = self.reviews.lock();
                let seen = reviews.entry(objective.clone()).or_default();
                *seen += 1;
                if objective == "implement ui" && *seen == 1 {
                    tool(
                        "tasks.review",
                        json!({"verdict": "reject", "notes": "the form must show validation errors"}),
                    )
                } else {
                    tool(
                        "tasks.review",
                        json!({"verdict": "approve", "notes": "criteria met"}),
                    )
                }
            }
            ("Front", "inbox", 0) => {
                let message = format!("mg_{}", between(full, "- mg_", " "));
                tool("messages.ack", json!({"id": message}))
            }
            _ => "done".to_owned(),
        };
        Ok(InvokeReply {
            text: reply,
            epoch_id: "fake".into(),
        })
    }
}

fn types(fixture: &Fixture, root: &str) -> Vec<String> {
    fixture
        .core
        .coordination()
        .events_after(0, Some(root), 500)
        .unwrap()
        .0
        .into_iter()
        .map(|e| e.event_type)
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn one_submission_reaches_a_reviewed_integrated_result_without_manual_routing() {
    let fixture = Fixture::new(|_| {});
    let fake = Fake::new(Scenario {
        ui_after_api: true,
        ..Default::default()
    });
    let root = fixture
        .submit("Fix the frontend form and backend validation")
        .task
        .id;
    fixture.run(&fake).await;

    let detail = fixture.detail(&root);
    assert_eq!(
        detail.task.status,
        TaskStatus::Completed,
        "{:?} {:?} followups={:#?}",
        detail.task.status_reason,
        detail.children,
        fake.followups.lock()
    );
    for child in &detail.children {
        assert_eq!(child.status, TaskStatus::Completed, "{child:?}");
    }
    assert_eq!(
        detail.usage.as_ref().unwrap().tokens,
        None,
        "unmeasured token usage is reported honestly"
    );

    // The plan was validated and owners came from configured capabilities.
    let api = fixture.child(&root, "implement api");
    let ui = fixture.child(&root, "implement ui");
    let merge = fixture.child(&root, "integrate and verify");
    assert_eq!(
        (
            api.task.owner.as_deref(),
            ui.task.owner.as_deref(),
            merge.task.owner.as_deref()
        ),
        (Some("Back"), Some("Front"), Some("Integrator"))
    );

    // Reviewer rejection produced a repair attempt with the feedback in the capsule.
    let ui_attempts: Vec<_> = fixture
        .core
        .coordination()
        .attempts(&ui.task.id)
        .unwrap()
        .into_iter()
        .filter(|a| a.kind == AttemptKind::Work)
        .collect();
    assert_eq!(ui_attempts.len(), 2);
    let repair_prompt = &fake.starts_of("Front", "work")[1].1;
    assert!(
        repair_prompt.contains("Feedback: rejected by Lead")
            && repair_prompt.contains("validation errors")
    );

    // The contract reached the dependant through the capsule, not through chat history.
    let ui_first = &fake.starts_of("Front", "work")[0].1;
    assert!(
        ui_first.contains("Contract: POST /orders -> 201 {id}; 422 {errors}"),
        "{ui_first}"
    );

    // Each work attempt ran in its own worktree; the shared checkout stayed clean.
    assert!(!fixture.repo.join("api.txt").exists());
    assert_eq!(git(&fixture.repo, &["status", "--porcelain"]), "");
    let commit = |detail: &TaskDetail| {
        detail
            .artifacts
            .iter()
            .rev()
            .find(|a| a.kind == "commit")
            .unwrap()
            .content_hash
            .clone()
            .unwrap()
    };
    let merged = commit(&fixture.detail(&merge.task.id));
    assert_eq!(
        git(&fixture.repo, &["show", &format!("{merged}:api.txt")]),
        "api"
    );
    assert_eq!(
        git(&fixture.repo, &["show", &format!("{merged}:ui.txt")]),
        "ui v2"
    );
    assert_eq!(
        git(
            &fixture.repo,
            &["show", &format!("{merged}:integration.txt")]
        ),
        "checked"
    );
    assert!(
        std::fs::read_dir(fixture.core.data_dir().join("worktrees"))
            .map(|d| d.count())
            .unwrap_or(0)
            == 0,
        "attempt worktrees are removed"
    );

    // The handoff DM was queued, delivered to a woken Front, and acknowledged.
    let messages = fixture
        .core
        .coordination()
        .messages(&root, None, None, None, 50)
        .unwrap();
    let handoff = messages
        .iter()
        .find(|(m, _)| m.kind == MessageKind::Handoff)
        .expect("handoff recorded");
    assert_eq!(handoff.0.sender, "Back");
    assert_eq!(handoff.1[0].state, DeliveryState::Acknowledged);
    assert!(!fake.starts_of("Front", "inbox").is_empty());

    // Role-scoped manifests: the coordinator could plan but not submit results, and vice versa.
    let plan_pack = &fake
        .starts
        .lock()
        .iter()
        .find(|s| s.0 == "Lead" && s.1 == "plan")
        .unwrap()
        .3
        .clone();
    assert!(plan_pack.contains("tasks.plan.propose") && !plan_pack.contains("tasks.result.submit"));
    let work_pack = &fake.starts_of("Back", "work")[0].1;
    assert!(work_pack.contains("tasks.result.submit") && !work_pack.contains("tasks.plan.propose"));

    // Progress is reconstructable from durable events after "disconnecting".
    let kinds = types(&fixture, &root);
    for expected in [
        "task.created",
        "task.plan_committed",
        "attempt.started",
        "task.result_submitted",
        "message.sent",
        "task.status_changed",
    ] {
        assert!(
            kinds.iter().any(|k| k == expected),
            "missing {expected} in {kinds:?}"
        );
    }
    let (_, high_water) = fixture
        .core
        .coordination()
        .events_after(0, Some(&root), 1)
        .unwrap();
    assert!(fixture
        .core
        .coordination()
        .events_after(high_water, Some(&root), 10)
        .unwrap()
        .0
        .is_empty());

    // Context metrics were recorded per attempt and stay within budget.
    let attempts = fixture.core.coordination().attempts(&root).unwrap();
    assert!(attempts.iter().all(|a| a
        .context_metrics
        .as_ref()
        .is_some_and(
            |m| m["total_bytes"].as_u64().unwrap() <= m["budget_bytes"].as_u64().unwrap()
        )));
    // Every attempt that got a reply records the runtime epoch that served it.
    let succeeded: Vec<_> = attempts
        .iter()
        .filter(|a| a.state == AttemptState::Succeeded)
        .collect();
    assert!(!succeeded.is_empty());
    assert!(succeeded
        .iter()
        .all(|a| a.runtime_epoch.as_deref() == Some("fake")));
}

#[tokio::test(flavor = "multi_thread")]
async fn parallel_edits_are_isolated_and_conflicts_reach_the_integrator() {
    let resolved = Fixture::new(|_| {});
    let fake = Fake::new(Scenario {
        conflict: true,
        resolve: true,
        ..Default::default()
    });
    let root = resolved.submit("parallel edits").task.id;
    resolved.run(&fake).await;
    assert_eq!(resolved.detail(&root).task.status, TaskStatus::Completed);
    let merge = resolved.child(&root, "integrate and verify");
    let sha = merge
        .artifacts
        .iter()
        .find(|a| a.kind == "commit")
        .unwrap()
        .content_hash
        .clone()
        .unwrap();
    assert_eq!(
        git(&resolved.repo, &["show", &format!("{sha}:shared.txt")]),
        "merged"
    );

    let unresolved = Fixture::new(|_| {});
    let fake = Fake::new(Scenario {
        conflict: true,
        resolve: false,
        ..Default::default()
    });
    let root = unresolved.submit("parallel edits").task.id;
    unresolved.run(&fake).await;
    let merge = unresolved.child(&root, "integrate and verify");
    assert_eq!(
        merge.task.status,
        TaskStatus::Failed,
        "conflict markers are never committed as a success"
    );
    assert!(merge
        .task
        .status_reason
        .unwrap()
        .contains("unresolved_conflict"));
    let detail = unresolved.detail(&root);
    assert_ne!(detail.task.status, TaskStatus::Completed);
    assert_eq!(detail.task.status, TaskStatus::Blocked);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_attempt_stops_dependants_and_never_reports_success() {
    let fixture = Fixture::new(|_| {});
    let fake = Fake::new(Scenario {
        fail_backend: true,
        ui_after_api: true,
        ..Default::default()
    });
    let root = fixture.submit("will fail").task.id;
    fixture.run(&fake).await;
    let api = fixture.child(&root, "implement api");
    assert_eq!(api.task.status, TaskStatus::Failed);
    assert_eq!(
        fixture.child(&root, "implement ui").task.status,
        TaskStatus::Blocked
    );
    assert_eq!(
        fixture.child(&root, "integrate and verify").task.status,
        TaskStatus::Blocked
    );
    assert_eq!(fixture.detail(&root).task.status, TaskStatus::Blocked);
    assert!(
        fake.starts_of("Front", "work").is_empty(),
        "dependants of failed work never start"
    );
    let attempts = fixture.core.coordination().attempts(&api.task.id).unwrap();
    assert_eq!(attempts[0].failure_class.as_deref(), Some("runtime"));
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_aborts_running_attempts_and_leaves_no_dispatch_behind() {
    let fixture = Fixture::new(|_| {});
    let fake = Fake::new(Scenario {
        hang_backend: true,
        ..Default::default()
    });
    let root = fixture.submit("hang").task.id;
    let mut scheduler = Scheduler::new(
        fixture.core.clone(),
        Some(fake.clone() as Arc<dyn AgentInvoker>),
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        scheduler.step().await.unwrap();
        if !fake.starts_of("Back", "work").is_empty() {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "backend work never started"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let api = fixture.child(&root, "implement api");
    assert_eq!(
        fixture
            .core
            .coordination()
            .attempts(&api.task.id)
            .unwrap()
            .iter()
            .filter(|a| a.state == AttemptState::Running)
            .count(),
        1
    );
    fixture.core.coordination().cancel(&root, "user").unwrap();
    scheduler.drain(Duration::from_secs(30)).await.unwrap();
    scheduler.stop().await;

    assert_eq!(fixture.detail(&root).task.status, TaskStatus::Cancelled);
    let attempts = fixture.core.coordination().attempts(&api.task.id).unwrap();
    assert!(
        attempts.iter().all(|a| a.state == AttemptState::Cancelled),
        "{attempts:?}"
    );
    assert!(fixture
        .core
        .coordination()
        .store()
        .read(|db| db.running_attempts(None))
        .unwrap()
        .is_empty());
    assert!(fake.starts_of("Integrator", "work").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn restart_marks_running_attempts_interrupted_and_retry_is_explicit() {
    let fixture = Fixture::new(|_| {});
    let fake = Fake::new(Scenario {
        hang_backend: true,
        ..Default::default()
    });
    let root = fixture.submit("crash").task.id;
    let mut first = Scheduler::new(
        fixture.core.clone(),
        Some(fake.clone() as Arc<dyn AgentInvoker>),
    );
    while fake.starts_of("Back", "work").is_empty() {
        first.step().await.unwrap();
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // "Crash": the scheduler vanishes without recording anything.
    std::mem::forget(first);
    let second = Scheduler::new(fixture.core.clone(), None);
    second.recover_startup();
    let api = fixture.child(&root, "implement api");
    assert_eq!(api.task.status, TaskStatus::Blocked);
    assert!(api.task.status_reason.unwrap().contains("interrupted"));
    let attempts = fixture.core.coordination().attempts(&api.task.id).unwrap();
    assert_eq!(attempts[0].state, AttemptState::Interrupted);
    let resumed = fixture
        .core
        .coordination()
        .resume(&root, true, 0, 0, "user")
        .unwrap();
    assert_eq!(
        resumed
            .children
            .iter()
            .find(|c| c.id == api.task.id)
            .unwrap()
            .status,
        TaskStatus::Ready
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn task_text_never_authorizes_global_memory_writes() {
    let fixture = Fixture::new(|_| {});
    let fake = Fake::new(Scenario {
        global_probe: true,
        ..Default::default()
    });
    fixture.submit("Global: pineapple rules");
    fixture.run(&fake).await;
    let followups = fake.followups.lock().clone();
    assert!(
        followups
            .iter()
            .any(|f| f.contains("error:") && f.contains("memory.global.propose")),
        "{followups:?}"
    );
    assert!(followups
        .iter()
        .all(|f| !f.contains("accepted global memory")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_worker_waits_on_its_question_and_resumes_with_the_answer_in_the_same_attempt() {
    let fixture = Fixture::new(|_| {});
    let fake = Fake::new(Scenario {
        ask_user: true,
        ..Default::default()
    });
    let root = fixture.submit("orders on a database").task.id;
    let mut scheduler = Scheduler::new(
        fixture.core.clone(),
        Some(fake.clone() as Arc<dyn AgentInvoker>),
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let api = loop {
        scheduler.step().await.unwrap();
        let waiting = fixture
            .detail(&root)
            .children
            .iter()
            .find(|c| c.objective == "implement api")
            .map(|c| fixture.detail(&c.id))
            .filter(|d| !d.questions.is_empty());
        if let Some(api) = waiting {
            break api;
        }
        assert!(std::time::Instant::now() < deadline, "backend never asked");
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    assert_eq!(api.questions[0].question, "sqlite or postgres?");
    assert_eq!(
        api.task.status,
        TaskStatus::Running,
        "asking keeps the attempt running"
    );
    fixture
        .core
        .coordination()
        .provide_input(&api.task.id, "sqlite", "user")
        .unwrap();
    scheduler.drain(Duration::from_secs(60)).await.unwrap();
    scheduler.stop().await;

    assert_eq!(fixture.detail(&root).task.status, TaskStatus::Completed);
    let attempts: Vec<_> = fixture
        .core
        .coordination()
        .attempts(&api.task.id)
        .unwrap()
        .into_iter()
        .filter(|a| a.kind == AttemptKind::Work)
        .collect();
    assert_eq!(attempts.len(), 1, "the answer resumed the same attempt");
    let kinds = types(&fixture, &root);
    assert!(
        kinds.iter().any(|k| k == "task.question") && kinds.iter().any(|k| k == "task.answered"),
        "{kinds:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn durable_wait_checkpoints_work_releases_capacity_and_continues_after_restart() {
    let mut fixture = Fixture::new(|_| {});
    let fake = Fake::new(Scenario {
        defer_user: true,
        ui_after_api: true,
        ..Default::default()
    });
    let root = fixture.submit("orders").task.id;
    let mut scheduler = Scheduler::new(
        fixture.core.clone(),
        Some(fake.clone() as Arc<dyn AgentInvoker>),
    );
    scheduler.drain(Duration::from_secs(30)).await.unwrap();
    let child = fixture.child(&root, "implement api");
    assert_eq!(child.task.status, TaskStatus::NeedsInput);
    assert_eq!(child.questions[0].question, "sqlite or postgres?");
    assert!(child.artifacts.iter().any(|a| a.kind == "checkpoint"));
    assert_eq!(
        fixture
            .core
            .coordination()
            .attempts(&child.task.id)
            .unwrap()[0]
            .state,
        AttemptState::Waiting
    );
    scheduler.stop().await;
    drop(scheduler);
    let config = fixture.core.config().clone();
    fixture.core = Arc::new(HivemindCore::new(config, fixture.root.join("hivemind.toml")).unwrap());
    assert_eq!(fixture.detail(&child.task.id).questions.len(), 1);
    fixture
        .core
        .coordination()
        .provide_input(&child.task.id, "sqlite", "user")
        .unwrap();
    let mut scheduler = Scheduler::new(
        fixture.core.clone(),
        Some(fake.clone() as Arc<dyn AgentInvoker>),
    );
    scheduler.recover_startup();
    scheduler.drain(Duration::from_secs(30)).await.unwrap();
    scheduler.stop().await;
    assert_eq!(fixture.detail(&root).task.status, TaskStatus::Completed);
    assert!(fixture.detail(&child.task.id).questions.is_empty());
}
