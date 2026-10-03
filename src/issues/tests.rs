use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::json;

use super::{
    model::*,
    service::{resolve_members, IssuesService, RawProposal},
    store::IssueStore,
    tools::IssueTools,
    *,
};
use crate::{
    config::{HivemindConfig, IssuesMode},
    conversation::{AgentInvoker, ToolHost},
    events::EventBus,
    runtime::{InvokeReply, InvokeRequest, SessionCursor},
};

fn service() -> IssuesService {
    let mut config = crate::config::IssuesConfig::default();
    config.enabled = true;
    config.max_issues_per_round = 2;
    IssuesService::new(
        IssueStore::in_memory().unwrap(),
        config,
        EventBus::new(),
    )
}

fn proposal(title: &str) -> RawProposal {
    RawProposal {
        persona: "Engineer".into(),
        kind: IssueKind::Bug,
        title: title.into(),
        body: "Deliveries drop on the first failure and never retry.".into(),
        priority: Priority::High,
    }
}

#[test]
fn pace_waits_for_the_interval_and_for_quiet_when_automatic() {
    let base = Pace {
        mode: IssuesMode::Scheduled,
        interval_secs: 100,
        idle_secs: 30,
        now: 1_000,
        anchor: 950,
        idle_since: Some(900),
        busy: false,
        round_running: false,
    };
    assert_eq!(pace_due(base), None);
    assert_eq!(
        pace_due(Pace {
            now: 1_050,
            ..base
        }),
        Some(Trigger::Scheduled)
    );
    assert_eq!(
        pace_due(Pace {
            now: 1_050,
            round_running: true,
            ..base
        }),
        None
    );
    let automatic = Pace {
        mode: IssuesMode::Automatic,
        now: 1_050,
        ..base
    };
    assert_eq!(pace_due(automatic), Some(Trigger::Automatic));
    assert_eq!(
        pace_due(Pace {
            busy: true,
            idle_since: None,
            ..automatic
        }),
        None
    );
    assert_eq!(
        pace_due(Pace {
            idle_since: Some(1_040),
            ..automatic
        }),
        None
    );
}

#[test]
fn filing_is_idempotent_capped_and_blocked_until_a_council_is_running() {
    let service = service();
    let err = service.propose(proposal("Retry webhook delivery")).unwrap_err();
    assert!(matches!(err, IssueError::Conflict(_)));

    let round = service
        .begin_round(Trigger::Manual, &["Engineer".into(), "Reviewer".into()])
        .unwrap();
    assert!(service
        .begin_round(Trigger::Manual, &["Engineer".into()])
        .is_err());

    let first = service
        .propose(proposal("Retry webhook delivery"))
        .unwrap();
    assert!(first.created);
    let again = service
        .propose(proposal("  retry   webhook   delivery "))
        .unwrap();
    assert!(!again.created);
    assert_eq!(again.issue.id, first.issue.id);

    service
        .propose(proposal("Surface failed deliveries"))
        .unwrap();
    let capped = service
        .propose(proposal("Record delivery latency"))
        .unwrap_err();
    assert!(matches!(capped, IssueError::Conflict(_)));

    let outsider = RawProposal {
        persona: "Reviewer".into(),
        ..proposal("Reviewer files nothing new")
    };
    // Reviewer is a member, but the cap is already full.
    assert!(service.propose(outsider).is_err());

    service.finish_round(&round.id, None).unwrap();
    let open = service.list(Some(IssueStatus::Open), None).unwrap();
    assert_eq!(open.len(), 2);

    let dismissed = service.dismiss(&first.issue.id, Some("not now".into())).unwrap();
    assert_eq!(dismissed.status, IssueStatus::Dismissed);
    let next = service
        .begin_round(Trigger::Scheduled, &["Engineer".into()])
        .unwrap();
    let refiled = service
        .propose(proposal("Retry webhook delivery"))
        .unwrap();
    assert!(refiled.created);
    assert_ne!(refiled.issue.id, first.issue.id);
    service
        .finish_round(&next.id, Some("stopped".into()))
        .unwrap();
    assert_eq!(
        service.round(&next.id).unwrap().status,
        RoundStatus::Failed
    );
}

#[test]
fn tools_refuse_work_outside_the_running_council() {
    let service = Arc::new(service());
    let tools = IssueTools::new(service.clone());
    assert!(tools.manifest(COUNCIL_ROOM, "Engineer").is_none());
    assert!(!tools.agent_originated("main"));
    assert!(tools.agent_originated(COUNCIL_ROOM));

    service
        .begin_round(Trigger::Manual, &["Engineer".into()])
        .unwrap();
    assert!(tools.manifest(COUNCIL_ROOM, "Engineer").is_some());
    assert!(tools.manifest("main", "Engineer").is_none());
    assert!(tools.manifest(COUNCIL_ROOM, "Reviewer").is_none());

    let filed = tools
        .execute(
            COUNCIL_ROOM,
            "Engineer",
            "issues.propose",
            &json!({
                "kind": "feature",
                "title": "Add delivery retries",
                "body": "Failed webhook deliveries should retry with backoff.",
                "priority": "medium"
            }),
        )
        .unwrap();
    assert!(filed.contains("\"created\":true"));
    let listed = tools
        .execute(COUNCIL_ROOM, "Engineer", "issues.list", &json!({}))
        .unwrap();
    assert!(listed.contains("Add delivery retries"));
    assert!(tools
        .execute(
            "main",
            "Engineer",
            "issues.propose",
            &json!({"kind":"bug","title":"Should not file","body":"This call is outside the council room."})
        )
        .is_err());
}

#[test]
fn members_follow_the_group_then_the_explicit_list_then_everyone() {
    let mut config = HivemindConfig::default_poc();
    config.issues.members = vec!["Reviewer".into()];
    assert_eq!(
        resolve_members(&config).unwrap(),
        vec!["Reviewer".to_owned()]
    );
    config.groups.push(crate::config::GroupConfig {
        name: "development".into(),
        members: vec!["Engineer".into(), "Reviewer".into()],
        mode: Default::default(),
        member_roles: Default::default(),
        reply_order: vec!["Reviewer".into()],
        workspace: None,
    });
    config.issues.group = Some("development".into());
    assert_eq!(
        resolve_members(&config).unwrap(),
        vec!["Reviewer".to_owned(), "Engineer".to_owned()]
    );
    config.issues.members = vec!["Missing".into()];
    config.issues.group = None;
    // resolve_members trusts the list; config validation is what rejects it.
    assert!(config.validate().is_err());
}

struct Scripted {
    prompts: Mutex<Vec<String>>,
    calls: Mutex<Vec<String>>,
}

#[async_trait]
impl AgentInvoker for Scripted {
    async fn cursor(&self, _: &crate::identity::AgentInstanceId) -> Option<SessionCursor> {
        None
    }

    async fn invoke(&self, request: InvokeRequest<'_>) -> anyhow::Result<InvokeReply> {
        let name = request.agent.name.clone();
        self.prompts.lock().unwrap().push(request.full.to_owned());
        let n = {
            let mut calls = self.calls.lock().unwrap();
            calls.push(name.clone());
            calls.iter().filter(|call| *call == &name).count()
        };
        let text = match (name.as_str(), n) {
            ("Engineer", 1) | ("Reviewer", 1) => "```hivemind-tool\n{\"name\":\"issues.propose\",\"args\":{\"kind\":\"bug\",\"title\":\"Retry webhook delivery\",\"body\":\"Deliveries drop after one attempt. Done when failures retry with backoff.\"}}\n```".to_owned(),
            _ => format!("{name} agrees the backlog is updated and nothing else should be filed."),
        };
        Ok(InvokeReply {
            text,
            epoch_id: "council".into(),
        })
    }
}

#[tokio::test]
async fn a_council_files_one_issue_and_does_not_duplicate_it() {
    let dir = std::env::temp_dir().join(format!(
        "hivemind-issues-{}-{}",
        std::process::id(),
        crate::coordination::model::new_id("t")
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("hivemind.toml");
    let mut config = HivemindConfig::default_poc();
    config.issues.enabled = true;
    config.issues.max_issues_per_round = 3;
    std::fs::write(&path, toml::to_string_pretty(&config).unwrap()).unwrap();
    let core = crate::core::HivemindCore::new(config, &path).unwrap();
    let scripted = Arc::new(Scripted {
        prompts: Mutex::new(Vec::new()),
        calls: Mutex::new(Vec::new()),
    });
    start_council(&core, Trigger::Manual, Some(scripted.clone()))
        .await
        .unwrap();
    let open = core.issues().list(Some(IssueStatus::Open), None).unwrap();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].title, "Retry webhook delivery");
    assert_eq!(open[0].proposed_by, "Engineer");
    assert_eq!(open[0].kind, IssueKind::Bug);
    let rounds = core.issues().rounds(10).unwrap();
    assert_eq!(rounds[0].status, RoundStatus::Completed);
    assert_eq!(rounds[0].issue_count, 1);
    let prompts = scripted.prompts.lock().unwrap();
    assert!(prompts.iter().any(|prompt| prompt.contains("Do not implement")));
    let _ = std::fs::remove_dir_all(&dir);
}
