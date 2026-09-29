use super::*;
use crate::identity::AgentInstanceId;
fn agent() -> Caller {
    Caller::agent(
        "group-a",
        "group-a",
        AgentInstanceId::new("group-a", "engineer"),
        "engineer",
        "engineer",
    )
}
fn write(content: &str) -> MemoryWrite {
    MemoryWrite {
        id: None,
        kind: "note".into(),
        content: content.into(),
        provenance: Provenance::default(),
        importance: 50,
        supersedes_memory_id: None,
    }
}
fn req(q: &str, scopes: Vec<SearchScope>) -> SearchRequest {
    SearchRequest {
        query: q.into(),
        scopes,
        limit: 10,
        include_historical: false,
    }
}
#[test]
fn persistence_reopen_fts_and_scope_isolation() {
    let path = std::env::temp_dir().join(format!(
        "hivemind-memory-{}-{}.sqlite",
        std::process::id(),
        now()
    ));
    let caller = agent();
    let id;
    {
        let s = MemoryService::open(&path).unwrap();
        let r = s
            .add_group(&caller, write("Websocket authentication uses JWT"))
            .unwrap();
        id = r.id;
        assert_eq!(
            s.search(&caller, &req("websocket JWT", vec![SearchScope::Group]))
                .unwrap()[0]
                .record
                .id,
            id
        );
        let other = Caller::agent(
            "group-b",
            "group-b",
            AgentInstanceId::new("group-b", "engineer"),
            "engineer",
            "engineer",
        );
        assert!(s
            .search(&other, &req("websocket", vec![SearchScope::Group]))
            .unwrap()
            .is_empty());
        assert!(s.store().get(&other, &id).is_err());
    }
    {
        let s = MemoryService::open(&path).unwrap();
        assert_eq!(
            s.store().get(&agent(), &id).unwrap().unwrap().content,
            "Websocket authentication uses JWT"
        );
    }
    let _ = std::fs::remove_file(path);
}
#[test]
fn provenance_supersession_and_archive_retention() {
    let s = MemoryService::new(MemoryStore::in_memory().unwrap());
    let c = agent();
    let old = s.add_group(&c, write("Frontend uses React")).unwrap();
    let mut next = write("Frontend uses Vue");
    next.supersedes_memory_id = Some(old.id.clone());
    let new = s.add_group(&c, next).unwrap();
    assert_eq!(
        s.store().get(&agent(), &old.id).unwrap().unwrap().status,
        MemoryStatus::Superseded
    );
    assert_eq!(new.supersedes_memory_id, Some(old.id));
    assert_eq!(new.provenance.source_actor.as_deref(), Some("engineer"));
    assert_eq!(
        s.search(&c, &req("React", vec![SearchScope::Group]))
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        s.search(
            &c,
            &SearchRequest {
                include_historical: true,
                ..req("React", vec![SearchScope::Group])
            }
        )
        .unwrap()
        .len(),
        1
    );
}

#[test]
fn caller_provenance_overlays_write_metadata_and_keeps_unspecified_fields() {
    let service = MemoryService::new(MemoryStore::in_memory().unwrap());
    let caller = agent().with_provenance(Provenance {
        source_room_id: Some("server-room".into()),
        source_turn_id: None,
        source_message_id: Some("server-message".into()),
        source_actor: Some("server-actor".into()),
        source_kind: Some("server-kind".into()),
    });
    let mut write = write("Provenance merge");
    write.provenance = Provenance {
        source_room_id: Some("write-room".into()),
        source_turn_id: Some("write-turn".into()),
        source_message_id: Some("write-message".into()),
        source_actor: Some("write-actor".into()),
        source_kind: Some("write-kind".into()),
    };

    let stored = service.add_group(&caller, write).unwrap();
    assert_eq!(
        stored.provenance,
        Provenance {
            source_room_id: Some("server-room".into()),
            source_turn_id: Some("write-turn".into()),
            source_message_id: Some("server-message".into()),
            source_actor: Some("server-actor".into()),
            source_kind: Some("server-kind".into()),
        }
    );
}
#[test]
fn proposals_and_authorization_reject_escalation() {
    let s = MemoryService::new(MemoryStore::in_memory().unwrap());
    let c = agent();
    assert!(s.propose_global(&c, write("I think this is good")).is_err());
    let unbound = agent().with_provenance(Provenance {
        source_turn_id: Some("turn-1".into()),
        source_kind: Some("accepted_decision".into()),
        ..Provenance::default()
    });
    assert!(s
        .propose_global(
            &unbound,
            write("Hivemind architecture: all agents use deterministic memory")
        )
        .is_err());
    let caller = agent()
        .with_provenance(Provenance {
            source_room_id: Some("group-a".into()),
            source_turn_id: Some("turn-user-1".into()),
            source_kind: Some("agent_proposal".into()),
            ..Provenance::default()
        })
        .authorize_global_proposal_from_user_event(
            "Hivemind architecture: all agents use deterministic memory",
            Provenance {
                source_room_id: Some("group-a".into()),
                source_turn_id: Some("turn-user-1".into()),
                source_message_id: Some("message-user-1".into()),
                source_actor: Some("user".into()),
                source_kind: Some("explicit_user_instruction".into()),
            },
        )
        .unwrap();
    let p = write("Hivemind architecture: all agents use deterministic memory");
    let accepted = s.propose_global(&caller, p).unwrap();
    assert_eq!(accepted.provenance.source_actor.as_deref(), Some("user"));
    assert!(s
        .propose_global(&caller, write("Hivemind global arbitrary assertion"))
        .is_err());
    let no_keyword_fact = "Use XYZ stack";
    let user_authorized = agent()
        .with_provenance(Provenance {
            source_kind: Some("agent_proposal".into()),
            ..Provenance::default()
        })
        .authorize_global_proposal_from_user_event(
            no_keyword_fact,
            Provenance {
                source_room_id: Some("group-a".into()),
                source_turn_id: Some("turn-user-2".into()),
                source_message_id: Some("message-user-2".into()),
                source_actor: Some("user".into()),
                source_kind: Some("explicit_user_instruction".into()),
            },
        )
        .unwrap();
    assert_eq!(
        s.propose_global(&user_authorized, write(no_keyword_fact))
            .unwrap()
            .content,
        no_keyword_fact
    );
    let mut private = write("do not share");
    private.id = Some("private-1".into());
    let rec = s.add_private(&c, private).unwrap();
    let other = Caller::agent(
        "group-a",
        "group-a",
        AgentInstanceId::new("group-a", "other"),
        "engineer",
        "other",
    );
    assert!(s.archive(&other, &rec.id).is_err());
    assert!(s.search(&c, &req("anything", vec![])).is_err());
}
#[test]
fn archive_messages_are_distinct_and_recent_is_bounded() {
    let s = MemoryService::new(MemoryStore::in_memory().unwrap());
    let c = agent();
    for (id, turn, content) in [
        ("m1", "t1", "First archive fact"),
        ("m2", "t2", "Second archive fact"),
        ("m3", "t3", "Third archive fact"),
    ] {
        s.append_room_message(
            &c,
            ArchivedMessage {
                id: id.into(),
                room_id: "group-a".into(),
                turn_id: turn.into(),
                speaker: "user".into(),
                content: content.into(),
                created_at: now(),
            },
        )
        .unwrap();
    }
    assert_eq!(s.recent_messages(&c, "group-a", 2).unwrap().len(), 2);
    assert_eq!(
        s.search(&c, &req("archive fact", vec![SearchScope::Archive]))
            .unwrap()
            .len(),
        3
    );
    assert!(s
        .append_room_message(
            &c,
            ArchivedMessage {
                id: "x".into(),
                room_id: "group-b".into(),
                turn_id: "t".into(),
                speaker: "user".into(),
                content: "no".into(),
                created_at: now()
            }
        )
        .is_err());
}
#[test]
fn complete_archive_turn_upserts_participants_and_searchable_messages() {
    let service = MemoryService::new(MemoryStore::in_memory().unwrap());
    let caller = agent();
    let make_turn = |content: &str, participant: &str| ArchivedTurn {
        id: "turn-1".into(),
        room_id: "group-a".into(),
        started_at: 10,
        completed_at: Some(20),
        metadata: serde_json::json!({"mode":"broadcast"}),
        participants: vec![ArchiveParticipant {
            participant_id: participant.into(),
            role: Some("worker".into()),
        }],
        messages: vec![ArchivedMessage {
            id: "message-1".into(),
            room_id: "group-a".into(),
            turn_id: "turn-1".into(),
            speaker: "engineer".into(),
            content: content.into(),
            created_at: 20,
        }],
    };
    service
        .append_archive_turn(&caller, make_turn("Old archived answer", "engineer"))
        .unwrap();
    service
        .append_archive_turn(&caller, make_turn("Revised searchable answer", "designer"))
        .unwrap();
    let archived = service
        .archive_turn(&caller, "group-a", "turn-1")
        .unwrap()
        .unwrap();
    assert_eq!(archived.participants[0].participant_id, "designer");
    assert_eq!(archived.messages.len(), 1);
    assert_eq!(archived.messages[0].content, "Revised searchable answer");
    assert_eq!(
        service
            .search(
                &caller,
                &req("Revised searchable", vec![SearchScope::Archive])
            )
            .unwrap()
            .len(),
        1
    );
    assert!(service
        .search(&caller, &req("Old archived", vec![SearchScope::Archive]))
        .unwrap()
        .is_empty());
    let other = Caller::agent(
        "group-b",
        "group-b",
        AgentInstanceId::new("group-b", "agent"),
        "other",
        "other",
    );
    assert!(service.archive_turn(&other, "group-a", "turn-1").is_err());
}
#[test]
fn archive_turns_and_participants_survive_reopen() {
    let path = std::env::temp_dir().join(format!(
        "hivemind-turn-{}-{}.sqlite",
        std::process::id(),
        now()
    ));
    let caller = agent();
    {
        let service = MemoryService::open(&path).unwrap();
        service
            .append_archive_turn(
                &caller,
                ArchivedTurn {
                    id: "persisted-turn".into(),
                    room_id: "group-a".into(),
                    started_at: 1,
                    completed_at: Some(2),
                    metadata: serde_json::json!({"canonical":true}),
                    participants: vec![ArchiveParticipant {
                        participant_id: "engineer".into(),
                        role: Some("owner".into()),
                    }],
                    messages: vec![ArchivedMessage {
                        id: "persisted-message".into(),
                        room_id: "group-a".into(),
                        turn_id: "persisted-turn".into(),
                        speaker: "engineer".into(),
                        content: "Durable SQLite transcript".into(),
                        created_at: 2,
                    }],
                },
            )
            .unwrap();
    }
    {
        let service = MemoryService::open(&path).unwrap();
        let turn = service
            .archive_turn(&caller, "group-a", "persisted-turn")
            .unwrap()
            .unwrap();
        assert_eq!(turn.participants[0].participant_id, "engineer");
        assert_eq!(turn.messages[0].content, "Durable SQLite transcript");
        assert_eq!(
            service
                .search(
                    &caller,
                    &req("Durable transcript", vec![SearchScope::Archive])
                )
                .unwrap()
                .len(),
            1
        );
    }
    let _ = std::fs::remove_file(path);
}
#[test]
fn solo_scope_context_and_global_archive_authorization() {
    let service = MemoryService::new(MemoryStore::in_memory().unwrap());
    let solo = Caller::agent(
        "solo-room",
        "",
        AgentInstanceId::new("solo-room", "engineer"),
        "engineer",
        "engineer",
    )
    .with_provenance(Provenance {
        source_room_id: Some("solo-room".into()),
        source_turn_id: Some("turn-1".into()),
        source_kind: Some("agent_proposal".into()),
        ..Provenance::default()
    });
    let private = service
        .add_private(&solo, write("Revisit local notes"))
        .unwrap();
    assert_eq!(
        private.scope,
        Scope::AgentInstance(AgentInstanceId::new("solo-room", "engineer"))
    );
    let persona = service
        .propose_persona(&solo, write("Prefers small service boundaries"))
        .unwrap();
    assert_eq!(persona.scope, Scope::Persona("engineer".into()));
    assert!(service.add_group(&solo, write("Group only")).is_err());
    assert!(service
        .store()
        .records_in_scope(&solo, &Scope::Group(String::new()))
        .is_err());

    let trusted = Caller::trusted_user("operator");
    let global = service.propose_global(&trusted, write("Hivemind architecture uses Rust"));
    let global = global.unwrap();
    assert!(service.archive(&solo, &global.id).is_err());
    assert!(service.archive(&trusted, &global.id).is_ok());
}

#[test]
fn group_state_and_runtime_epochs_are_durable_and_instance_scoped() {
    let path = std::env::temp_dir().join(format!(
        "hivemind-state-{}-{}.sqlite",
        std::process::id(),
        now()
    ));
    let caller = agent();
    let epoch_id;
    {
        let service = MemoryService::open(&path).unwrap();
        service
            .set_group_state(&caller, serde_json::json!({"goal":"ship API"}))
            .unwrap();
        let epoch = service
            .start_runtime_epoch(&caller, "pi", serde_json::json!({"pid":42}))
            .unwrap();
        epoch_id = epoch.id.clone();
        let other = Caller::agent(
            "group-a",
            "group-a",
            AgentInstanceId::new("group-a", "other"),
            "engineer",
            "other",
        );
        assert!(service
            .end_runtime_epoch(&other, &epoch.id, epoch.started_at + 1)
            .is_err());
        service
            .end_runtime_epoch(&caller, &epoch.id, epoch.started_at + 1)
            .unwrap();
    }
    {
        let service = MemoryService::open(&path).unwrap();
        assert_eq!(
            service.group_state(&caller).unwrap().unwrap().state["goal"],
            "ship API"
        );
        let epochs = service.runtime_epochs(&caller, 10).unwrap();
        assert_eq!(epochs.len(), 1);
        assert_eq!(epochs[0].id, epoch_id);
        assert!(epochs[0].ended_at.is_some());
    }
    let _ = std::fs::remove_file(path);
}

#[test]
fn new_ids_are_time_first_fixed_width_and_process_unique() {
    let first = new_id();
    let second = new_id();
    let parts: Vec<&str> = first.split('-').collect();
    assert_eq!(parts.len(), 4, "unexpected id shape: {first}");
    assert_eq!(parts[0], "memory");
    assert_eq!(
        parts[1].len(),
        20,
        "time field must be fixed-width: {first}"
    );
    assert!(parts[1].chars().all(|c| c.is_ascii_digit()));
    assert_eq!(
        parts[2].len(),
        6,
        "sequence field must be fixed-width: {first}"
    );
    assert!(parts[2].chars().all(|c| c.is_ascii_digit()));
    // The pid suffix is what keeps ids minted by concurrent processes distinct.
    assert_eq!(parts[3], std::process::id().to_string());
    assert_ne!(first, second);
    assert!(
        first < second,
        "ids must sort chronologically by creation order: {first} !< {second}"
    );
}

#[test]
fn natural_language_question_retrieves_partial_matches_and_misses_without_overlap() {
    let service = MemoryService::new(MemoryStore::in_memory().unwrap());
    let caller = agent();
    let stored = service
        .add_group(&caller, write("Websocket authentication uses JWT"))
        .unwrap();
    // Every-token AND matching returned nothing here; partial matches must
    // still retrieve the record the question is asking about.
    let hits = service
        .search(
            &caller,
            &req(
                "what websocket authentication do you know?",
                vec![SearchScope::Group],
            ),
        )
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].record.id, stored.id);

    // A query sharing no token with any authorized record returns nothing.
    let unrelated = service
        .search(&caller, &req("unrelated zzzq", vec![SearchScope::Group]))
        .unwrap();
    assert!(unrelated.is_empty());
}

#[test]
fn persona_memory_spans_instances_but_not_personas() {
    let service = MemoryService::new(MemoryStore::in_memory().unwrap());
    let author = Caller::agent(
        "dev-room",
        "dev",
        AgentInstanceId::new("dev-room", "engineer"),
        "engineer",
        "engineer",
    )
    .with_provenance(Provenance {
        source_room_id: Some("dev-room".into()),
        source_turn_id: Some("turn-1".into()),
        source_kind: Some("agent_proposal".into()),
        ..Provenance::default()
    });
    let stored = service
        .propose_persona(&author, write("Prefers small service boundaries"))
        .unwrap();
    assert_eq!(stored.scope, Scope::Persona("engineer".into()));

    // A different instance of the same persona still reads the record.
    let same_persona_other_instance = Caller::agent(
        "security-room",
        "security",
        AgentInstanceId::new("security-room", "engineer"),
        "engineer",
        "engineer",
    );
    let hits = service
        .search(
            &same_persona_other_instance,
            &req("service boundaries", vec![SearchScope::Persona]),
        )
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].record.id, stored.id);
    assert_eq!(
        service
            .store()
            .get(&same_persona_other_instance, &stored.id)
            .unwrap()
            .unwrap()
            .content,
        "Prefers small service boundaries"
    );

    // A different persona can neither search nor fetch it.
    let other_persona = Caller::agent(
        "dev-room",
        "dev",
        AgentInstanceId::new("dev-room", "designer"),
        "designer",
        "designer",
    );
    assert!(service
        .search(
            &other_persona,
            &req("service boundaries", vec![SearchScope::Persona])
        )
        .unwrap()
        .is_empty());
    assert!(service.store().get(&other_persona, &stored.id).is_err());
}

#[test]
fn authorized_global_memory_is_retrievable_from_another_room_and_agent() {
    let service = MemoryService::new(MemoryStore::in_memory().unwrap());
    let fact = "Hivemind architecture: runtimes are disposable";
    let author = Caller::agent(
        "dev-room",
        "dev",
        AgentInstanceId::new("dev-room", "engineer"),
        "engineer",
        "engineer",
    )
    .with_provenance(Provenance {
        source_room_id: Some("dev-room".into()),
        source_turn_id: Some("turn-1".into()),
        source_kind: Some("agent_proposal".into()),
        ..Provenance::default()
    })
    .authorize_global_proposal_from_user_event(
        fact,
        Provenance {
            source_room_id: Some("dev-room".into()),
            source_turn_id: Some("turn-1".into()),
            source_message_id: Some("message-1".into()),
            source_actor: Some("user".into()),
            source_kind: Some("explicit_user_instruction".into()),
        },
    )
    .unwrap();
    let stored = service.propose_global(&author, write(fact)).unwrap();
    assert_eq!(stored.scope, Scope::Hivemind);

    // Any authorized agent in any room may read global memory.
    let reader = Caller::agent(
        "security-room",
        "security",
        AgentInstanceId::new("security-room", "reviewer"),
        "reviewer",
        "reviewer",
    );
    let hits = service
        .search(
            &reader,
            &req("runtimes disposable", vec![SearchScope::Global]),
        )
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].record.id, stored.id);

    // Policy still gates writes: the reader cannot mint global memory.
    assert!(service
        .propose_global(&reader, write("Unrelated global claim"))
        .is_err());
}

#[test]
fn private_memory_identity_is_collision_safe_for_arbitrary_ids() {
    let service = MemoryService::new(MemoryStore::in_memory().unwrap());
    let first = Caller::agent("a/b", "group", AgentInstanceId::new("a/b", "c"), "c", "c");
    let second = Caller::agent("a", "group", AgentInstanceId::new("a", "b/c"), "b/c", "b/c");
    let same_persona_other_room = Caller::agent(
        "another-room",
        "group",
        AgentInstanceId::new("another-room", "c"),
        "c",
        "c",
    );
    let same_room_other_persona = Caller::agent(
        "a/b",
        "group",
        AgentInstanceId::new("a/b", "other"),
        "other",
        "other",
    );
    let unicode = Caller::agent(
        "雪 / room",
        "group",
        AgentInstanceId::new("雪 / room", "persona:# ☕"),
        "persona:# ☕",
        "persona:# ☕",
    );
    let first_record = service
        .add_private(&first, write("collision first note"))
        .unwrap();
    let second_record = service
        .add_private(&second, write("collision second note"))
        .unwrap();
    let unicode_record = service
        .add_private(&unicode, write("unicode punctuation note"))
        .unwrap();
    let same_persona_record = service
        .add_private(&same_persona_other_room, write("same persona, other room"))
        .unwrap();
    let same_room_record = service
        .add_private(&same_room_other_persona, write("same room, other persona"))
        .unwrap();

    for (caller, visible, hidden) in [
        (&first, &first_record.id, &second_record.id),
        (&second, &second_record.id, &first_record.id),
        (
            &same_persona_other_room,
            &same_persona_record.id,
            &first_record.id,
        ),
        (
            &same_room_other_persona,
            &same_room_record.id,
            &first_record.id,
        ),
    ] {
        assert_eq!(
            service.store().get(caller, visible).unwrap().unwrap().id,
            *visible
        );
        assert!(service.store().get(caller, hidden).is_err());
    }
    assert_eq!(
        service
            .store()
            .get(&unicode, &unicode_record.id)
            .unwrap()
            .unwrap()
            .content,
        "unicode punctuation note"
    );
    assert_ne!(
        first.agent_instance_id.encode(),
        second.agent_instance_id.encode()
    );
    assert_eq!(
        AgentInstanceId::decode(&unicode.agent_instance_id.encode()),
        Some(unicode.agent_instance_id)
    );
}

#[test]
fn legacy_memory_and_runtime_epochs_remain_opaque_after_schema_migration() {
    let connection = rusqlite::Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
             CREATE TABLE memories (
               id TEXT PRIMARY KEY, layer TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL,
               kind TEXT NOT NULL, content TEXT NOT NULL, source_room_id TEXT, source_turn_id TEXT,
               source_message_id TEXT, source_actor TEXT, source_kind TEXT, created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL, status TEXT NOT NULL, importance INTEGER NOT NULL,
               supersedes_memory_id TEXT
             );
             CREATE TABLE runtime_epochs (
               id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), instance_id TEXT NOT NULL,
               runtime TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, metadata_json TEXT NOT NULL
             );
             INSERT INTO rooms(id,name,updated_at) VALUES('legacy-room','',1);
             INSERT INTO memories VALUES(
               'legacy-private','private','agent_instance','ai1:3:a/b1:c','note','legacy private note',
               NULL,NULL,NULL,NULL,NULL,1,1,'active',50,NULL
             );
             INSERT INTO runtime_epochs(id,room_id,instance_id,runtime,started_at,ended_at,metadata_json)
               VALUES('legacy-epoch','legacy-room','ai1:11:legacy-room1:a','pi',1,NULL,'{}');",
        )
        .unwrap();
    let store = MemoryStore::from_connection(connection).unwrap();
    let legacy_scope = Scope::LegacyAgentInstance("ai1:3:a/b1:c".into());
    let trusted = Caller::trusted_user("operator");
    assert_eq!(
        store
            .get(&trusted, "legacy-private")
            .unwrap()
            .unwrap()
            .scope,
        legacy_scope
    );
    let first = Caller::agent("a/b", "group", AgentInstanceId::new("a/b", "c"), "c", "c");
    let second = Caller::agent("a", "group", AgentInstanceId::new("a", "b/c"), "b/c", "b/c");
    assert!(store.get(&first, "legacy-private").is_err());
    assert!(store.get(&second, "legacy-private").is_err());

    let caller = Caller::agent(
        "legacy-room",
        "group",
        AgentInstanceId::new("legacy-room", "a"),
        "a",
        "a",
    );
    let service = MemoryService::new(store);
    assert!(service
        .end_runtime_epoch(&caller, "legacy-epoch", 2)
        .is_err());
    assert!(service.runtime_epochs(&caller, 10).unwrap().is_empty());
    {
        let connection = service.store().connection.lock().unwrap();
        let (instance_id, identity_version, ended_at): (String, i64, Option<i64>) = connection
            .query_row(
                "SELECT instance_id,identity_version,ended_at FROM runtime_epochs WHERE id='legacy-epoch'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(instance_id, "ai1:11:legacy-room1:a");
        assert_eq!(identity_version, 0);
        assert_eq!(ended_at, None);
    }

    let new_epoch = service
        .start_runtime_epoch(&caller, "pi", serde_json::json!({}))
        .unwrap();
    assert_eq!(
        new_epoch.agent_instance_id,
        AgentInstanceId::new("legacy-room", "a")
    );
    assert_eq!(service.runtime_epochs(&caller, 10).unwrap(), [new_epoch]);
}
#[test]
fn runtime_epoch_identity_decodes_only_versioned_encoding() {
    let canonical = AgentInstanceId::new("a/b", "c/d");
    assert_eq!(
        decode_agent_instance_id("a/b", &canonical.encode()).unwrap(),
        canonical
    );
    assert!(decode_agent_instance_id("a/b", "a/b/c/d").is_err());
    assert!(decode_agent_instance_id("a", "a/b/c").is_err());
}

#[test]
fn runtime_epoch_identity_rejects_mismatched_canonical_and_unknown_legacy_values() {
    let other_room = AgentInstanceId::new("other-room", "persona");
    assert!(decode_agent_instance_id("row-room", &other_room.encode()).is_err());
    assert!(decode_agent_instance_id("row-room", "other-room/persona").is_err());
}

#[test]
fn equal_score_records_order_reproducibly_and_active_outranks_superseded() {
    let service = MemoryService::new(MemoryStore::in_memory().unwrap());
    let caller = agent();
    let record = |id: &str, status: MemoryStatus| MemoryRecord {
        id: id.into(),
        layer: Layer::Group,
        scope: Scope::Group("group-a".into()),
        kind: "note".into(),
        content: "Shared release checklist".into(),
        provenance: Provenance::default(),
        created_at: 1_000,
        updated_at: 1_000,
        status,
        importance: 50,
        supersedes_memory_id: None,
    };
    // Identical content, scope, and timestamps make the scores exactly
    // equal, so only the id tie-break decides the order.
    let older = new_id();
    let newer = new_id();
    assert!(older < newer);
    service
        .store()
        .insert(&record(&older, MemoryStatus::Active))
        .unwrap();
    service
        .store()
        .insert(&record(&newer, MemoryStatus::Active))
        .unwrap();
    let ranked = |include_historical: bool| {
        service
            .search(
                &caller,
                &SearchRequest {
                    include_historical,
                    ..req("release checklist", vec![SearchScope::Group])
                },
            )
            .unwrap()
            .into_iter()
            .map(|result| result.record.id)
            .collect::<Vec<_>>()
    };
    assert_eq!(ranked(false), vec![older.clone(), newer.clone()]);
    assert_eq!(ranked(false), ranked(false));

    // A superseded record for the same query ranks below both active ones.
    let superseded = new_id();
    service
        .store()
        .insert(&record(&superseded, MemoryStatus::Superseded))
        .unwrap();
    assert_eq!(ranked(true), vec![older, newer, superseded]);
}
#[test]
fn topic_key_column_migrates_a_database_created_before_it_existed() {
    let connection = rusqlite::Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "CREATE TABLE memories (
               id TEXT PRIMARY KEY, layer TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL,
               kind TEXT NOT NULL, content TEXT NOT NULL, source_room_id TEXT, source_turn_id TEXT,
               source_message_id TEXT, source_actor TEXT, source_kind TEXT, created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','superseded','archived')),
               importance INTEGER NOT NULL CHECK(importance BETWEEN 0 AND 100), supersedes_memory_id TEXT,
               FOREIGN KEY(supersedes_memory_id) REFERENCES memories(id));
             INSERT INTO memories VALUES('old','private','agent_instance','x','note','old note',NULL,NULL,NULL,NULL,NULL,1,1,'active',50,NULL);",
        )
        .unwrap();
    let service = MemoryService::new(MemoryStore::from_connection(connection).unwrap());
    assert_eq!(service.store().load("old").unwrap().unwrap().content, "old note");
    let (_, updated) = service.upsert_private(&agent(), "k", write("new")).unwrap();
    assert!(!updated);
    let (_, updated) = service.upsert_private(&agent(), "k", write("newer")).unwrap();
    assert!(updated);
}
