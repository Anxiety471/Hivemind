use anyhow::{bail, Result};

use super::{Caller, MemoryWrite, Provenance, Scope};

pub(super) fn ensure_can_access(caller: &Caller, scope: &Scope) -> Result<()> {
    let ok = caller.trusted
        || match scope {
            Scope::Group(x) => !caller.group_id.is_empty() && x == &caller.group_id,
            Scope::Archive(x) | Scope::Conversation(x) => x == &caller.room_id,
            Scope::AgentInstance(x) => x == &caller.agent_instance_id,
            Scope::Persona(x) => x == &caller.persona_id,
            Scope::LegacyAgentInstance(_) => false,
            Scope::Hivemind => true,
        };
    if !ok {
        bail!("unauthorized memory scope");
    }
    Ok(())
}
pub(super) fn validate_write(w: &MemoryWrite) -> Result<()> {
    if w.content.trim().is_empty() {
        bail!("memory content cannot be empty");
    }
    if w.content.chars().count() > 16_384 {
        bail!("memory content exceeds 16384 characters");
    }
    if w.kind.trim().is_empty() || w.kind.chars().count() > 100 {
        bail!("memory kind must contain 1 to 100 characters");
    }
    if w.id
        .as_ref()
        .is_some_and(|id| id.is_empty() || id.len() > 200)
    {
        bail!("memory id must contain 1 to 200 bytes");
    }
    Ok(())
}
pub(super) fn validate_broad_proposal(
    caller: &Caller,
    scope: &Scope,
    w: &MemoryWrite,
) -> Result<()> {
    let text = w.content.to_lowercase();
    let transient = [
        "my task",
        "i am assigned",
        "i'm assigned",
        "in this room",
        "in our room",
        "today",
        "temporary",
        "private note",
        "secret",
        "password",
        "token",
        "api key",
    ];
    if transient.iter().any(|x| text.contains(x)) {
        bail!("proposal contains room-specific, transient, or sensitive content");
    }
    let global_user_authorized = matches!(scope, Scope::Hivemind)
        && caller
            .authorized_global_proposal
            .as_ref()
            .is_some_and(|authorization| {
                authorization.exact_content.trim() == w.content.trim()
                    && authorization.provenance.source_kind.as_deref()
                        == Some("explicit_user_instruction")
            });
    let general = match scope {
        Scope::Persona(_) => [
            "prefer",
            "preference",
            "experienced",
            "familiar",
            "skill",
            "specialist",
            "knowledge",
            "style",
        ]
        .iter()
        .any(|x| text.contains(x)),
        Scope::Hivemind => {
            global_user_authorized
                || [
                    "project",
                    "hivemind",
                    "architecture",
                    "system-wide",
                    "global",
                    "core",
                    "all agents",
                    "runtime",
                    "rust",
                    "decision",
                ]
                .iter()
                .any(|x| text.contains(x))
        }
        _ => false,
    };
    if !general {
        bail!("proposal does not meet deterministic scope relevance policy");
    }
    let provenance = if matches!(scope, Scope::Hivemind) && !caller.trusted {
        global_user_authorized.then(|| {
            &caller
                .authorized_global_proposal
                .as_ref()
                .unwrap()
                .provenance
        })
    } else {
        Some(&caller.provenance)
    };
    let provenance_ok = caller.trusted
        || provenance.is_some_and(|p| {
            p.source_room_id.is_some()
                || p.source_turn_id.is_some()
                || p.source_message_id.is_some()
        });
    let trusted_source = caller.trusted
        || match scope {
            Scope::Persona(_) => caller.provenance.source_kind.as_deref().is_some_and(|s| {
                matches!(
                    s,
                    "agent_proposal"
                        | "explicit_user_instruction"
                        | "configuration"
                        | "structured_project_event"
                        | "accepted_decision"
                )
            }),
            Scope::Hivemind => global_user_authorized,
            _ => false,
        };
    if !trusted_source {
        bail!("broader-scope proposal lacks an allowed deterministic source");
    }
    if !provenance_ok {
        bail!("broader-scope proposals require canonical provenance");
    }
    if let Scope::Persona(id) = scope {
        if !caller.trusted && id != &caller.persona_id {
            bail!("cannot propose for another persona");
        }
    }
    Ok(())
}
pub(super) fn effective_provenance(
    caller: &Caller,
    content: &str,
    supplied: Provenance,
) -> Provenance {
    if let Some(authorization) =
        caller
            .authorized_global_proposal
            .as_ref()
            .filter(|authorization| {
                authorization.exact_content.trim() == content.trim()
                    && authorization.provenance.source_kind.as_deref()
                        == Some("explicit_user_instruction")
            })
    {
        return authorization.provenance.clone();
    }
    operation_provenance(caller, supplied)
}
pub(super) fn operation_provenance(caller: &Caller, mut supplied: Provenance) -> Provenance {
    let trusted = &caller.provenance;
    if trusted.source_room_id.is_some() {
        supplied.source_room_id.clone_from(&trusted.source_room_id);
    }
    if trusted.source_turn_id.is_some() {
        supplied.source_turn_id.clone_from(&trusted.source_turn_id);
    }
    if trusted.source_message_id.is_some() {
        supplied
            .source_message_id
            .clone_from(&trusted.source_message_id);
    }
    if trusted.source_actor.is_some() {
        supplied.source_actor.clone_from(&trusted.source_actor);
    }
    if trusted.source_kind.is_some() {
        supplied.source_kind.clone_from(&trusted.source_kind);
    }
    supplied
}

pub(super) fn normalized_provenance(caller: &Caller, mut provenance: Provenance) -> Provenance {
    if provenance.source_actor.is_none() {
        provenance.source_actor = Some(caller.actor.clone());
    }
    provenance
}
