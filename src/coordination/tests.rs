use std::{collections::HashSet, sync::Arc};

use super::CoordinationTools;

use serde_json::json;

use super::{
    model::*,
    policy::{Plan, PlanTask, Roster},
    service::*,
    store::{CoordinationStore, TaskFilter},
};
use crate::{
    config::{AgentConfig, CoordinationConfig, HivemindConfig},
    events::{DomainEventKind, EventBus},
};

pub(super) fn persona(name: &str, caps: &[&str], perms: &[&str], workspace: &str) -> AgentConfig {
    AgentConfig {
        name: name.into(),
        runtime: "pi".into(),
        system_prompt: format!("You are {name}."),
        workspace: workspace.into(),
        model: None,
        reasoning: None,
        fast: None,
        fallback_models: Vec::new(),
        role: None,
        capabilities: caps.iter().map(|c| c.to_string()).collect(),
        permissions: perms.iter().map(|c| c.to_string()).collect(),
        roles: Vec::new(),
        tool_access: None,
        web: true,
        authorized_work: Vec::new(),
        unauthorized_work: Vec::new(),
    }
}

pub(super) fn team_config(workspace: &str) -> HivemindConfig {
    let mut config = HivemindConfig::default_poc();
    config.agents = vec![
        persona(
            "Lead",
            &[],
            &["coordinate", "delegate", "review"],
            workspace,
        ),
        persona("Front", &["frontend"], &[], workspace),
        persona("Back", &["backend"], &[], workspace),
        persona(
            "Integrator",
            &["frontend", "backend"],
            &["integrate"],
            workspace,
        ),
        persona("Outsider", &["backend"], &[], "/elsewhere"),
    ];
    config.conversation.reply_order.clear();
    config.coordination = CoordinationConfig {
        enabled: true,
        ..CoordinationConfig::default()
    };
    config
}

fn service_with(config: &HivemindConfig) -> (Arc<CoordinationService>, EventBus) {
    let events = EventBus::new();
    let service = CoordinationService::new(
        CoordinationStore::in_memory().unwrap(),
        config.coordination.clone(),
        Roster::from_config(config),
        events.clone(),
    );
    (Arc::new(service), events)
}

fn service() -> Arc<CoordinationService> {
    service_with(&team_config(".")).0
}

fn task(key: &str, caps: &[&str], deps: &[&str]) -> PlanTask {
    PlanTask {
        key: key.into(),
        objective: format!("do {key}"),
        acceptance: vec![format!("{key} works")],
        capabilities: caps.iter().map(|c| c.to_string()).collect(),
        owner: None,
        reviewer: None,
        depends_on: deps.iter().map(|d| d.to_string()).collect(),
        contract: Some(format!("{key} contract")),
        kind: None,
    }
}

fn submit(service: &CoordinationService, objective: &str, plan: Option<Plan>) -> TaskDetail {
    service
        .submit(SubmitTask {
            objective: objective.into(),
            acceptance: vec![],
            capabilities: vec![],
            workspace: None,
            plan,
            idempotency_key: None,
        })
        .unwrap()
}

fn claim(service: &CoordinationService) -> Vec<Dispatch> {
    service.claim(8, &|_| false, &HashSet::new()).unwrap()
}

fn ctx(service: &CoordinationService, dispatch: &Dispatch) -> ToolCtx {
    service
        .bind(&task_room(&dispatch.task.id), &dispatch.attempt.persona)
        .unwrap()
        .expect("live attempt binds")
}

fn evidence(outcome: Verdict) -> Vec<Evidence> {
    vec![Evidence {
        check: "cargo test".into(),
        outcome,
        detail: "ok".into(),
    }]
}

fn result(outcome: Verdict) -> ResultIn {
    ResultIn {
        summary: "did it".into(),
        artifacts: vec![ArtifactIn {
            kind: "file".into(),
            reference: "a.txt".into(),
            description: "file".into(),
        }],
        verification: evidence(outcome),
    }
}

fn status(service: &CoordinationService, id: &str) -> TaskStatus {
    service.detail(id).unwrap().task.status
}

/// Root with a committed api → ui plan; returns (root id, api id, ui id).
fn planned(service: &CoordinationService) -> (String, String, String) {
    let plan = Plan {
        tasks: vec![
            task("api", &["backend"], &[]),
            task("ui", &["frontend"], &["api"]),
        ],
    };
    let detail = submit(service, "orders form", Some(plan));
    let ids: Vec<_> = detail
        .children
        .iter()
        .map(|c| (c.objective.clone(), c.id.clone()))
        .collect();
    let find = |name: &str| {
        ids.iter()
            .find(|(o, _)| o == &format!("do {name}"))
            .unwrap()
            .1
            .clone()
    };
    (detail.task.id.clone(), find("api"), find("ui"))
}

#[test]
fn submission_is_idempotent_and_refused_when_disabled() {
    let service = service();
    let submit_once = || {
        service
            .submit(SubmitTask {
                objective: "same".into(),
                acceptance: vec![],
                capabilities: vec![],
                workspace: None,
                plan: None,
                idempotency_key: Some("k1".into()),
            })
            .unwrap()
    };
    let (first, second) = (submit_once(), submit_once());
    assert_eq!(first.task.id, second.task.id);
    assert_eq!(
        service
            .list_tasks(&TaskFilter {
                roots_only: true,
                limit: 10,
                ..Default::default()
            })
            .unwrap()
            .len(),
        1
    );
    assert_eq!(first.task.status, TaskStatus::Planning);
    assert_eq!(first.task.coordinator, "Lead");

    let mut config = team_config(".");
    config.coordination.enabled = false;
    let (disabled, _) = service_with(&config);
    let error = disabled
        .submit(SubmitTask {
            objective: "x".into(),
            acceptance: vec![],
            capabilities: vec![],
            workspace: None,
            plan: None,
            idempotency_key: None,
        })
        .unwrap_err();
    assert_eq!(error, CoordError::Disabled);
    assert!(disabled
        .claim(4, &|_| false, &HashSet::new())
        .unwrap()
        .is_empty());
}

#[test]
fn missing_skill_or_coordinator_needs_input_instead_of_guessing() {
    let service = service();
    let detail = service
        .submit(SubmitTask {
            objective: "train a model".into(),
            acceptance: vec![],
            capabilities: vec!["ml".into()],
            workspace: None,
            plan: None,
            idempotency_key: None,
        })
        .unwrap();
    assert_eq!(detail.task.status, TaskStatus::NeedsInput);
    assert!(detail.task.status_reason.unwrap().contains("ml"));
    assert!(
        claim(&service).is_empty(),
        "needs_input work is never dispatched"
    );

    let mut config = team_config(".");
    config.agents.iter_mut().for_each(|a| a.permissions.clear());
    let (nobody, _) = service_with(&config);
    let detail = submit(&nobody, "anything", None);
    assert_eq!(detail.task.status, TaskStatus::NeedsInput);
    assert!(detail.task.status_reason.unwrap().contains("coordinate"));
}

#[test]
fn coordinator_plans_and_dependants_wait_for_prerequisites() {
    let service = service();
    let root = submit(&service, "fix frontend and backend", None);
    let dispatches = claim(&service);
    assert_eq!(dispatches.len(), 1);
    assert_eq!(dispatches[0].attempt.kind, AttemptKind::Plan);
    assert_eq!(dispatches[0].attempt.persona, "Lead");
    let ctx = ctx(&service, &dispatches[0]);

    // Cycles and unknown skills fail validation and commit nothing.
    let cyclic = Plan {
        tasks: vec![task("a", &[], &["b"]), task("b", &[], &["a"])],
    };
    assert!(service
        .propose_plan(&ctx, &cyclic, None)
        .unwrap_err()
        .to_string()
        .contains("cycle"));
    let missing = Plan {
        tasks: vec![task("a", &["ml"], &[])],
    };
    assert!(service.propose_plan(&ctx, &missing, None).is_err());
    assert_eq!(service.detail(&root.task.id).unwrap().children.len(), 0);

    let plan = Plan {
        tasks: vec![
            task("api", &["backend"], &[]),
            task("ui", &["frontend"], &["api"]),
        ],
    };
    assert!(
        service
            .propose_plan(&ctx, &plan, Some(99))
            .unwrap_err()
            .to_string()
            .contains("revision"),
        "stale revision"
    );
    let ids = service.propose_plan(&ctx, &plan, None).unwrap();
    let (api, ui) = (&ids[0].1, &ids[1].1);
    assert_eq!(status(&service, &root.task.id), TaskStatus::Running);
    assert_eq!(
        (status(&service, api), status(&service, ui)),
        (TaskStatus::Ready, TaskStatus::Submitted)
    );
    let detail = service.detail(ui).unwrap();
    assert_eq!(detail.task.prerequisites, vec![api.clone()]);

    // A second plan is refused once the root left planning.
    assert!(service.propose_plan(&ctx, &plan, None).is_err());
    service
        .finish_attempt(&dispatches[0].attempt.id, AttemptEnd::Completed)
        .unwrap();

    let work = claim(&service);
    assert_eq!(work.len(), 1, "only the unblocked task dispatches");
    assert_eq!(
        (work[0].attempt.kind, work[0].attempt.persona.as_str()),
        (AttemptKind::Work, "Back")
    );
    assert_eq!(status(&service, api), TaskStatus::Running);
}

#[test]
fn stale_fencing_and_expired_leases_reject_results() {
    let service = service();
    let (root, api, _ui) = planned(&service);
    let work = claim(&service);
    let ctx = ctx(&service, &work[0]);

    let mut stale = ctx.clone();
    stale.fencing += 1;
    assert!(matches!(
        service.submit_result(&stale, result(Verdict::Passed)),
        Err(CoordError::Conflict(_))
    ));

    service.store().pin_clock(service.store().now() + 400);
    let error = service
        .submit_result(&ctx, result(Verdict::Passed))
        .unwrap_err();
    assert!(error.to_string().contains("lease expired"), "{error}");
    assert_eq!(
        status(&service, &api),
        TaskStatus::Running,
        "an expired attempt cannot complete work"
    );

    let interrupted = service.interrupt_orphans(&HashSet::new(), false).unwrap();
    assert_eq!(interrupted, 1);
    let detail = service.detail(&api).unwrap();
    assert_eq!(detail.task.status, TaskStatus::Blocked);
    assert!(detail.task.status_reason.unwrap().contains("retry"));
    assert_eq!(
        service.attempts(&api).unwrap()[0].state,
        AttemptState::Interrupted
    );
    assert!(
        claim(&service).is_empty(),
        "interrupted work is never replayed automatically"
    );

    // Explicit retry authorization re-queues it; the root stays visible.
    service.resume(&root, true, 0, 0, "user").unwrap();
    assert_eq!(status(&service, &api), TaskStatus::Ready);
}

#[test]
fn completion_needs_evidence_a_deliverable_and_an_independent_verdict() {
    let service = service();
    let (root, api, ui) = planned(&service);
    let work = claim(&service);
    let owner = ctx(&service, &work[0]);

    assert!(
        service
            .submit_result(
                &owner,
                ResultIn {
                    verification: vec![],
                    ..result(Verdict::Passed)
                }
            )
            .is_err(),
        "no evidence"
    );
    let forged = ResultIn {
        artifacts: vec![ArtifactIn {
            kind: "commit".into(),
            reference: "x".into(),
            description: String::new(),
        }],
        ..result(Verdict::Passed)
    };
    assert!(
        matches!(
            service.submit_result(&owner, forged),
            Err(CoordError::Forbidden(_))
        ),
        "agents cannot mint commit artifacts"
    );
    service
        .submit_result(&owner, result(Verdict::Failed))
        .unwrap();
    assert_eq!(status(&service, &api), TaskStatus::Review);
    service
        .finish_attempt(&work[0].attempt.id, AttemptEnd::Completed)
        .unwrap();
    assert_eq!(
        status(&service, &api),
        TaskStatus::Review,
        "submission alone never completes"
    );

    let review = claim(&service);
    assert_eq!(
        (review[0].attempt.kind, review[0].attempt.persona.as_str()),
        (AttemptKind::Review, "Lead")
    );
    let reviewer = ctx(&service, &review[0]);
    let error = service.review(&reviewer, true, "").unwrap_err();
    assert!(
        error.to_string().contains("failed"),
        "failed evidence blocks approval: {error}"
    );
    assert_eq!(
        service
            .review(&reviewer, false, "")
            .unwrap_err()
            .to_string(),
        "a rejection needs notes explaining what must change"
    );
    assert_eq!(
        service
            .review(&reviewer, false, "run the tests for real")
            .unwrap(),
        TaskStatus::Ready
    );
    assert!(service.detail(&api).unwrap().task.feedback[0].contains("run the tests"));
    service
        .finish_attempt(&review[0].attempt.id, AttemptEnd::Completed)
        .unwrap();

    // Repair attempt, then approval unlocks the dependant and finally the root.
    let repair = claim(&service);
    let owner = ctx(&service, &repair[0]);
    service
        .submit_result(&owner, result(Verdict::Passed))
        .unwrap();
    service
        .finish_attempt(&repair[0].attempt.id, AttemptEnd::Completed)
        .unwrap();
    let review = claim(&service);
    let reviewer = ctx(&service, &review[0]);
    // The owner of the task can never approve it.
    let mut impostor = reviewer.clone();
    impostor.persona = "Back".into();
    assert!(service.review(&impostor, true, "").is_err());
    assert_eq!(
        service.review(&reviewer, true, "criteria met").unwrap(),
        TaskStatus::Completed
    );
    service
        .finish_attempt(&review[0].attempt.id, AttemptEnd::Completed)
        .unwrap();
    assert_eq!(status(&service, &ui), TaskStatus::Ready);

    let work = claim(&service);
    let owner = ctx(&service, &work[0]);
    assert_eq!(work[0].attempt.persona, "Front");
    service
        .submit_result(&owner, result(Verdict::Passed))
        .unwrap();
    service
        .finish_attempt(&work[0].attempt.id, AttemptEnd::Completed)
        .unwrap();
    let review = claim(&service);
    let reviewer = ctx(&service, &review[0]);
    service.review(&reviewer, true, "ok").unwrap();
    service
        .finish_attempt(&review[0].attempt.id, AttemptEnd::Completed)
        .unwrap();
    assert_eq!(
        status(&service, &root),
        TaskStatus::Review,
        "children done → root review, not completed"
    );
    let review = claim(&service);
    assert_eq!(review[0].task.id, root);
    let reviewer = ctx(&service, &review[0]);
    assert_eq!(
        service.review(&reviewer, true, "integrated").unwrap(),
        TaskStatus::Completed
    );
    assert_eq!(status(&service, &root), TaskStatus::Completed);
}

#[test]
fn failed_prerequisite_stops_dependants_and_blocks_the_root() {
    let service = service();
    let (root, api, ui) = planned(&service);
    let work = claim(&service);
    service
        .finish_attempt(
            &work[0].attempt.id,
            AttemptEnd::Failed {
                class: "runtime".into(),
                detail: "boom".into(),
            },
        )
        .unwrap();
    assert_eq!(status(&service, &api), TaskStatus::Failed);
    service.refresh().unwrap();
    let ui = service.detail(&ui).unwrap();
    assert_eq!(ui.task.status, TaskStatus::Blocked);
    assert!(ui.task.status_reason.unwrap().contains("dependency"));
    let root = service.detail(&root).unwrap();
    assert_eq!(root.task.status, TaskStatus::Blocked);
    assert!(claim(&service).is_empty());
}

fn team_in_root(service: &CoordinationService) -> (String, ToolCtx) {
    let root = submit(service, "coordinate", None);
    let dispatch = claim(service).remove(0);
    (root.task.id, ctx(service, &dispatch))
}

#[test]
fn messages_queue_deduplicate_and_never_loop_on_acks() {
    let service = service();
    let (root, lead) = team_in_root(&service);
    let request = |body: &str, to: &[&str]| SendMessage {
        recipients: to.iter().map(|s| s.to_string()).collect(),
        group: None,
        kind: MessageKind::Request,
        body: body.into(),
        artifacts: vec![],
        causation: None,
        idempotency_key: None,
    };

    let (message, duplicate) = service
        .send_message(&lead, request("what is the error shape?", &["Back"]))
        .unwrap();
    assert!(!duplicate);
    assert_eq!(
        service
            .send_message(&lead, request("what is the error shape?", &["Back"]))
            .unwrap()
            .0
            .id,
        message.id,
        "equivalent send dedupes"
    );
    let keyed = SendMessage {
        idempotency_key: Some("once".into()),
        ..request("other", &["Back"])
    };
    let first = service.send_message(&lead, keyed).unwrap().0;
    let keyed = SendMessage {
        idempotency_key: Some("once".into()),
        ..request("changed body", &["Back"])
    };
    assert_eq!(service.send_message(&lead, keyed).unwrap().0.id, first.id);

    // Cross-workspace, unknown, self, and empty recipients are refused.
    assert!(matches!(
        service.send_message(&lead, request("hi", &["Outsider"])),
        Err(CoordError::Forbidden(_))
    ));
    assert!(service
        .send_message(&lead, request("hi", &["Ghost"]))
        .is_err());
    assert!(service
        .send_message(&lead, request("hi", &["Lead"]))
        .is_err());
    assert!(service.send_message(&lead, request("hi", &[])).is_err());
    assert!(service
        .send_message(
            &lead,
            SendMessage {
                artifacts: vec!["ar_missing".into()],
                ..request("hi", &["Back"])
            }
        )
        .is_err());

    // The DM only queues; the scheduler turns it into one inbox attempt for Back.
    let wakes = service.store().read(|db| db.wake_queue(10)).unwrap();
    assert_eq!(wakes.len(), 2);
    service
        .finish_attempt(
            &service.attempts(&root).unwrap()[0].id,
            AttemptEnd::Completed,
        )
        .unwrap();
    let dispatches = claim(&service);
    let inbox: Vec<_> = dispatches
        .iter()
        .filter(|d| d.attempt.kind == AttemptKind::Inbox)
        .collect();
    assert_eq!(
        inbox.len(),
        1,
        "queued mail for one persona collapses into one attempt"
    );
    assert_eq!(inbox[0].deliveries.len(), 2);
    let back = ctx(&service, inbox[0]);

    // Status and ack messages are recorded but never wake anyone.
    let status_msg = SendMessage {
        kind: MessageKind::Status,
        ..request("halfway", &["Lead"])
    };
    service.send_message(&back, status_msg).unwrap();
    let ack = SendMessage {
        kind: MessageKind::Ack,
        causation: Some(message.id.clone()),
        ..request("got it", &["Lead"])
    };
    let (ack, _) = service.send_message(&back, ack).unwrap();
    assert_eq!(ack.depth, 1);
    let wake_after: Vec<_> = service.store().read(|db| db.wake_queue(10)).unwrap();
    assert!(
        wake_after.iter().all(|(d, _)| d.recipient != "Lead"),
        "status/ack never schedule work"
    );
    // A request that answers an ack is delivered but does not wake (loop guard).
    let reply = SendMessage {
        causation: Some(ack.id.clone()),
        ..request("thanks!", &["Lead"])
    };
    let (reply, _) = service.send_message(&back, reply).unwrap();
    let delivery = service
        .store()
        .read(|db| db.delivery(&reply.id, "Lead"))
        .unwrap()
        .unwrap();
    assert!(!delivery.wake);
    assert!(service.ack(&back, &message.id).is_ok());
    assert!(service.ack(&back, "mg_nope").is_err());
}

#[test]
fn deep_causation_chains_stop_waking_recipients() {
    let mut config = team_config(".");
    config.coordination.max_message_depth = 1;
    let (service, _) = service_with(&config);
    let (_root, lead) = team_in_root(&service);
    let send = |cause: Option<String>, body: &str| {
        service.send_message(
            &lead,
            SendMessage {
                recipients: vec!["Back".into()],
                group: None,
                kind: MessageKind::Request,
                body: body.into(),
                artifacts: vec![],
                causation: cause,
                idempotency_key: None,
            },
        )
    };
    // Lead is a party to its own message (sender), so it may chain on it.
    let first = send(None, "one").unwrap().0;
    let second = send(Some(first.id.clone()), "two").unwrap().0;
    let third = send(Some(second.id.clone()), "three").unwrap().0;
    let wake = |id: &str| {
        service
            .store()
            .read(|db| db.delivery(id, "Back"))
            .unwrap()
            .unwrap()
            .wake
    };
    assert!(wake(&first.id) && wake(&second.id));
    assert!(
        !wake(&third.id),
        "beyond max_message_depth the message is delivered without waking"
    );
}

#[test]
fn groups_are_reused_scoped_and_lose_removed_members() {
    let service = service();
    let (root, lead) = team_in_root(&service);
    let create = |roles: &[&str]| {
        service.create_group(
            &lead,
            CreateGroup {
                purpose: "Orders contract".into(),
                roles: roles.iter().map(|r| r.to_string()).collect(),
                members: vec![],
            },
        )
    };
    let (group, reused) = create(&["frontend", "backend"]).unwrap();
    assert!(!reused);
    let members: Vec<_> = group.members.iter().map(|m| m.persona.as_str()).collect();
    assert_eq!(members, ["Back", "Front", "Lead"]);
    let (again, reused) = create(&["backend", "frontend"]).unwrap();
    assert!(
        reused && again.id == group.id,
        "same purpose and membership reuses the group"
    );
    assert!(
        create(&["ml"]).is_err(),
        "unfillable roles never spawn agents"
    );
    assert!(service
        .create_group(
            &lead,
            CreateGroup {
                purpose: "x".into(),
                roles: vec![],
                members: vec!["Outsider".into()]
            }
        )
        .is_err());

    // Group posts reach members except the sender.
    let (message, _) = service
        .send_message(
            &lead,
            SendMessage {
                recipients: vec![],
                group: Some(group.id.clone()),
                kind: MessageKind::Status,
                body: "hello".into(),
                artifacts: vec![],
                causation: None,
                idempotency_key: None,
            },
        )
        .unwrap();
    assert_eq!(message.recipients, ["Back", "Front"]);

    // Removal is revision-checked, audited, and queues a session rotation.
    assert!(service
        .update_members(&lead, &group.id, &[], &["Front".into()], Some(9))
        .unwrap_err()
        .to_string()
        .contains("revision"));
    let updated = service
        .update_members(&lead, &group.id, &[], &["Front".into()], Some(1))
        .unwrap();
    assert_eq!(updated.revision, 2);
    assert_eq!(updated.members.len(), 2);
    let rotations = service.take_rotations();
    assert!(rotations
        .iter()
        .any(|(id, reason)| id.persona_id == "Front" && *reason == "membership_changed"));
    let (events, _) = service.events_after(0, Some(&root), 500).unwrap();
    assert!(events
        .iter()
        .any(|e| e.event_type == "group.members_changed"));

    // Non-managers cannot create groups.
    service
        .finish_attempt(
            &service.attempts(&root).unwrap()[0].id,
            AttemptEnd::Completed,
        )
        .unwrap();
    service
        .operator_message(
            &root,
            &["Front".into()],
            MessageKind::Request,
            "look at this",
        )
        .unwrap();
    let inbox = claim(&service);
    let front = ctx(&service, &inbox[0]);
    assert!(matches!(
        service.create_group(
            &front,
            CreateGroup {
                purpose: "mine".into(),
                roles: vec![],
                members: vec!["Back".into()]
            }
        ),
        Err(CoordError::Forbidden(_))
    ));
    assert!(
        service.get_group(&front, &group.id).is_err(),
        "removed members lose group reads"
    );
}

#[test]
fn cancel_cascades_and_budget_exhaustion_blocks_visibly() {
    let mut config = team_config(".");
    config.coordination.max_dispatches = 2;
    let (service, _) = service_with(&config);
    let (root, api, ui) = planned(&service);
    // One dispatch left after the (structured) plan; the second claim exhausts it.
    let first = claim(&service);
    assert_eq!(first.len(), 1);
    service
        .submit_result(&ctx(&service, &first[0]), result(Verdict::Passed))
        .unwrap();
    service
        .finish_attempt(&first[0].attempt.id, AttemptEnd::Completed)
        .unwrap();
    let second = claim(&service);
    assert_eq!(second.len(), 1, "second dispatch is within budget (review)");
    let reviewer = ctx(&service, &second[0]);
    service.review(&reviewer, true, "ok").unwrap();
    service
        .finish_attempt(&second[0].attempt.id, AttemptEnd::Completed)
        .unwrap();
    assert!(claim(&service).is_empty());
    let detail = service.detail(&root).unwrap();
    assert_eq!(detail.task.status, TaskStatus::Blocked);
    assert!(detail
        .task
        .status_reason
        .unwrap()
        .contains("budget exhausted"));
    assert_eq!(detail.usage.unwrap().dispatches, 2);

    // Raising the budget and resuming continues from the blocked root.
    service.resume(&root, false, 4, 0, "user").unwrap();
    assert_ne!(status(&service, &root), TaskStatus::Blocked);

    let cancelled = service.cancel(&root, "user").unwrap();
    assert_eq!(cancelled.task.status, TaskStatus::Cancelled);
    assert_eq!(
        status(&service, &api),
        TaskStatus::Completed,
        "finished work is not rewritten by a later cancel"
    );
    assert_eq!(status(&service, &ui), TaskStatus::Cancelled);
    assert!(claim(&service).is_empty());
    assert_eq!(
        service.cancel(&root, "user").unwrap().task.status,
        TaskStatus::Cancelled,
        "idempotent"
    );
}

#[test]
fn coordination_tools_are_bounded_by_role_and_never_take_identity_from_arguments() {
    use crate::conversation::ToolHost;
    let service = service();
    let (_root, _lead) = team_in_root(&service);
    let host = CoordinationTools::new(
        service.clone(),
        std::sync::Arc::new(crate::access::Audit::in_memory().unwrap()),
    );
    let room = |id: &str| task_room(id);
    let running = service
        .store()
        .read(|db| db.running_attempts(None))
        .unwrap();
    let plan_room = room(&running[0].task_id);

    let manifest = host.manifest(&plan_room, "Lead").unwrap();
    assert!(manifest.contains("tasks.plan.propose") && manifest.contains("groups.create"));
    assert!(
        !manifest.contains("tasks.review") && !manifest.contains("tasks.result.submit"),
        "tools outside the role are not offered"
    );
    assert!(
        host.manifest(&plan_room, "Front").is_none(),
        "no attempt, no tools"
    );
    assert!(host.manifest("solo-Lead", "Lead").is_none());

    // Unlisted tools cannot be executed even if guessed.
    let error = host
        .execute(
            &plan_room,
            "Lead",
            "tasks.review",
            &json!({"verdict": "approve"}),
        )
        .unwrap_err();
    assert!(error.to_string().contains("not available"));
    // Identity in arguments is ignored: the sender is the bound persona.
    let sent = host.execute(&plan_room, "Lead", "messages.send", &json!({"to": ["Back"], "kind": "request", "body": "hi", "sender": "Front", "persona": "Front"})).unwrap();
    assert!(sent.contains("queued"));
    let message = service
        .store()
        .read(|db| db.list_messages(&running[0].task_id, None, None, None, 10))
        .unwrap()
        .remove(0);
    assert_eq!(message.sender, "Lead");
    // A thread filter returns only that thread's messages.
    let by_thread = service
        .store()
        .read(|db| db.list_messages(&running[0].task_id, None, Some(&message.thread), None, 10))
        .unwrap();
    assert_eq!(by_thread.len(), 1);
    assert!(service
        .store()
        .read(|db| db.list_messages(&running[0].task_id, None, Some("no-such-thread"), None, 10))
        .unwrap()
        .is_empty());
    assert!(host
        .execute(
            &plan_room,
            "Lead",
            "messages.send",
            &json!({"to": ["Back"], "kind": "nonsense", "body": "hi"})
        )
        .is_err());
    assert!(host.agent_originated(&plan_room));
    assert!(!host.agent_originated("main"));
}

#[test]
fn outbox_events_survive_a_crash_between_commit_and_publish() {
    let directory = std::env::temp_dir().join(format!("hivemind-outbox-{}", new_id("t")));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("coordination.sqlite3");
    let config = team_config(".");
    {
        let events = EventBus::new();
        let service = CoordinationService::new(
            CoordinationStore::open(&path).unwrap(),
            config.coordination.clone(),
            Roster::from_config(&config),
            events,
        );
        service.set_publish(false); // the process "dies" before handing events to the bus
        submit(&service, "durable", None);
    }
    let events = EventBus::new();
    let mut receiver = events.subscribe();
    let service = CoordinationService::new(
        CoordinationStore::open(&path).unwrap(),
        config.coordination.clone(),
        Roster::from_config(&config),
        events,
    );
    service.flush();
    let mut types = Vec::new();
    while let Ok(event) = receiver.try_recv() {
        if let DomainEventKind::Coordination { event_type, .. } = &event.payload {
            types.push(event_type.clone());
        }
    }
    assert!(types.contains(&"task.created".to_owned()), "{types:?}");
    let (replay, high_water) = service.events_after(0, None, 100).unwrap();
    assert!(replay.len() as i64 <= high_water && !replay.is_empty());
    assert!(service
        .events_after(high_water, None, 10)
        .unwrap()
        .0
        .is_empty());
    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn listing_and_reads_never_contact_a_runtime_and_activity_is_derived() {
    let service = service();
    let (_root, api, _ui) = planned(&service);
    let activity = service.activity().unwrap();
    let state = |name: &str| {
        activity
            .iter()
            .find(|a| a.persona == name)
            .unwrap()
            .state
            .clone()
    };
    assert_eq!(
        state("Back"),
        "offline",
        "queued work with no scheduler running is offline"
    );
    service.set_scheduler_running(true);
    let activity = service.activity().unwrap();
    assert_eq!(
        activity.iter().find(|a| a.persona == "Back").unwrap().state,
        "queued"
    );
    let work = claim(&service);
    assert_eq!(work[0].task.id, api);
    let activity = service.activity().unwrap();
    let back = activity.iter().find(|a| a.persona == "Back").unwrap();
    assert_eq!(back.state, "working");
    assert_eq!(back.running[0].task_id, api);
    assert_eq!(
        activity.iter().find(|a| a.persona == "Lead").unwrap().state,
        "idle"
    );
}

#[test]
fn task_prompts_stay_bounded_scoped_and_never_clip_mandatory_content() {
    use super::capsule::build_prompt;
    use crate::conversation::ToolHost;
    let service = service();
    let (root, api, _ui) = planned(&service);
    // A second root the same persona also works in: its mail must never leak into the first.
    let (other_root, _, _) = planned(&service);
    service
        .operator_message(
            &other_root,
            &["Back".into()],
            MessageKind::Request,
            "SECRET-OTHER-ROOT ask",
        )
        .unwrap();
    let dispatch = claim(&service)
        .into_iter()
        .find(|d| d.task.id == api)
        .expect("api work dispatched");

    let mut dropped = String::new();
    for step in 0..100 {
        let body = if step == 50 {
            format!(
                "EARLY-CONTRACT: errors are {{code,message}} {}",
                "x".repeat(900)
            )
        } else {
            format!("step {step}: {}", "x".repeat(900))
        };
        let message = service
            .operator_message(&api, &["Back".into()], MessageKind::Status, &body)
            .unwrap();
        if step == 50 {
            dropped = message.id;
        }
    }
    let budget = 6000;
    let prompt = build_prompt(&service, &dispatch, budget).unwrap().unwrap();
    assert!(prompt.text.len() <= budget, "{} bytes", prompt.text.len());
    assert_eq!(prompt.metrics["inbox_items"], 5);
    assert_eq!(prompt.metrics["inbox_truncated"], true);
    assert!(
        prompt.text.contains("Objective:\ndo api") && prompt.text.contains("1. api works"),
        "mandatory sections are complete"
    );
    assert!(
        !prompt.text.contains("SECRET-OTHER-ROOT"),
        "another root's mail never enters the pack"
    );
    assert!(
        !prompt.text.contains("EARLY-CONTRACT") && !prompt.text.contains("step 99"),
        "the pack shows only the oldest five waiting items, not the whole mailbox"
    );

    // Repeated feedback rounds do not grow the pack: only the newest items are kept.
    let size_after = |rounds: usize| {
        for round in 0..rounds {
            service
                .store()
                .write(|db| {
                    db.push_feedback(
                        &api,
                        &format!("rejected round {round}: {}", "y".repeat(700)),
                    )
                })
                .unwrap();
        }
        build_prompt(&service, &dispatch, budget)
            .unwrap()
            .unwrap()
            .text
            .len()
    };
    let (few, many) = (size_after(6), size_after(100));
    assert!(many <= budget && many < few + 400, "{few} vs {many}");

    // The early contract stays recoverable by exact reference, whatever the pack dropped.
    let host = CoordinationTools::new(
        service.clone(),
        std::sync::Arc::new(crate::access::Audit::in_memory().unwrap()),
    );
    let found = host
        .execute(
            &task_room(&api),
            "Back",
            "context.lookup",
            &json!({"kind": "message", "id": dropped}),
        )
        .unwrap();
    assert!(found.contains("EARLY-CONTRACT"), "{found}");
    let denied = host.execute(
        &task_room(&api),
        "Back",
        "context.lookup",
        &json!({"kind": "task", "id": other_root}),
    );
    assert!(denied.is_err(), "lookup never crosses root tasks");

    // An oversized goal fails the dispatch instead of being clipped.
    let big = service
        .submit(SubmitTask {
            objective: "z".repeat(7000),
            acceptance: vec![],
            capabilities: vec![],
            workspace: None,
            plan: None,
            idempotency_key: None,
        })
        .unwrap();
    let plan_dispatch = claim(&service)
        .into_iter()
        .find(|d| d.task.id == big.task.id)
        .unwrap();
    assert!(build_prompt(&service, &plan_dispatch, 4000)
        .unwrap()
        .is_err());
    let _ = root;
}

#[test]
fn group_and_reassign_tools_follow_permissions_and_roles_not_prose() {
    use crate::conversation::ToolHost;
    let offered = |perms: &[&str], roles: &[&str]| {
        let mut config = team_config(".");
        config.agents[2].permissions = perms.iter().map(|p| p.to_string()).collect();
        config.agents[2].roles = roles.iter().map(|r| r.to_string()).collect();
        let (service, _) = service_with(&config);
        planned(&service);
        let work = claim(&service);
        assert_eq!(work[0].attempt.persona, "Back");
        let host = CoordinationTools::new(
            service.clone(),
            Arc::new(crate::access::Audit::in_memory().unwrap()),
        );
        let manifest = host.manifest(&task_room(&work[0].task.id), "Back").unwrap();
        let groups =
            manifest.contains("groups.create") && manifest.contains("groups.members.update");
        let delegate = manifest.contains("tasks.delegate");
        let created = service.create_group(
            &ctx(&service, &work[0]),
            CreateGroup {
                purpose: "x".into(),
                roles: vec!["frontend".into()],
                members: vec![],
            },
        );
        (groups, delegate, created.is_ok())
    };
    assert_eq!(
        offered(&[], &[]),
        (false, false, false),
        "a plain worker manages nothing"
    );
    assert_eq!(
        offered(&["group.manage"], &[]),
        (true, false, true),
        "group.manage alone opens groups only"
    );
    assert_eq!(
        offered(&["task.reassign"], &[]),
        (false, true, false),
        "task.reassign alone offers delegation, not groups"
    );
    assert_eq!(
        offered(&["delegate"], &[]),
        (true, true, true),
        "delegate implies group.manage and task.reassign"
    );
    assert_eq!(
        offered(&[], &["coordinator", "implementor"]),
        (true, true, true),
        "roles grant what direct permissions grant"
    );
    assert_eq!(
        offered(&[], &["worker"]),
        (false, false, false),
        "a role without coordination permissions grants none"
    );
}

#[test]
fn reassigning_cannot_make_the_owner_its_own_reviewer() {
    let mut config = team_config(".");
    config.agents[1] = persona("Front", &["frontend", "backend"], &["review"], ".");
    let (service, _) = service_with(&config);
    let (_root, lead) = team_in_root(&service);
    let mut api = task("api", &["backend"], &[]);
    api.owner = Some("Back".into());
    api.reviewer = Some("Front".into());
    let ids = service
        .propose_plan(&lead, &Plan { tasks: vec![api] }, None)
        .unwrap();
    let api_id = &ids[0].1;

    let error = service.reassign(&lead, api_id, "Front", None).unwrap_err();
    assert!(
        matches!(error, CoordError::Forbidden(_)) && error.to_string().contains("reviewer"),
        "{error}"
    );
    assert_eq!(
        service.detail(api_id).unwrap().task.owner.as_deref(),
        Some("Back"),
        "the failed reassignment changed nothing"
    );
    service.reassign(&lead, api_id, "Integrator", None).unwrap();
    assert_eq!(
        service.detail(api_id).unwrap().task.owner.as_deref(),
        Some("Integrator")
    );
}

#[test]
fn gated_coordination_decisions_are_audited_with_the_bound_identity() {
    use crate::{access::AuditFilter, conversation::ToolHost};
    let service = service();
    let (_root, _lead) = team_in_root(&service);
    let audit = Arc::new(crate::access::Audit::in_memory().unwrap());
    let host = CoordinationTools::new(service.clone(), audit.clone());
    let running = service
        .store()
        .read(|db| db.running_attempts(None))
        .unwrap();
    let plan_room = task_room(&running[0].task_id);

    assert!(host
        .execute(
            &plan_room,
            "Lead",
            "tasks.review",
            &json!({"verdict": "approve"})
        )
        .is_err());
    host.execute(
        &plan_room,
        "Lead",
        "groups.create",
        &json!({"purpose": "contract", "roles": ["frontend"]}),
    )
    .unwrap();
    host.execute(&plan_room, "Lead", "messages.inbox", &json!({}))
        .unwrap();

    let entries = audit
        .list(&AuditFilter {
            limit: 10,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        entries.len(),
        2,
        "the ungated inbox read leaves no record: {entries:?}"
    );
    assert_eq!(
        (
            entries[0].action.as_str(),
            entries[0].permission.as_str(),
            entries[0].allowed
        ),
        ("groups.create", "group.manage", true)
    );
    assert_eq!(
        (entries[1].action.as_str(), entries[1].allowed),
        ("tasks.review", false)
    );
    assert!(entries
        .iter()
        .all(|e| e.persona == "Lead" && e.resource.starts_with("task:")));
}

#[test]
fn agent_evidence_cannot_bypass_host_checks_or_reuse_proof_for_another_commit() {
    let service = service();
    let execution = Arc::new(
        crate::execution::ExecutionStore::open(
            ":memory:",
            crate::execution::ExecutionConfig {
                checks: vec![crate::execution::CheckConfig {
                    name: "host-test".into(),
                    command: vec!["true".into()],
                    timeout_secs: 1,
                }],
                ..Default::default()
            },
        )
        .unwrap(),
    );
    service.set_execution(execution.clone());
    let (_, api, _) = planned(&service);
    let work = claim(&service);
    let owner = ctx(&service, &work[0]);
    service
        .submit_result(&owner, result(Verdict::Passed))
        .unwrap();
    service
        .record_artifact(
            &api,
            Some(&work[0].attempt.id),
            "commit",
            "branch@sha2",
            Some("sha2"),
            "host commit",
        )
        .unwrap();
    service
        .finish_attempt(&work[0].attempt.id, AttemptEnd::Completed)
        .unwrap();
    let review = claim(&service);
    let reviewer = ctx(&service, &review[0]);
    assert!(service
        .review(&reviewer, true, "agent says tests passed")
        .is_err());
    execution
        .record_check(&api, "sha1", "host-test", &json!({"passed":true}), true)
        .unwrap();
    assert!(service.review(&reviewer, true, "old proof").is_err());
    execution
        .record_check(&api, "sha2", "host-test", &json!({"passed":true}), true)
        .unwrap();
    assert_eq!(
        service
            .review(&reviewer, true, "host checks passed")
            .unwrap(),
        TaskStatus::Completed
    );
}
