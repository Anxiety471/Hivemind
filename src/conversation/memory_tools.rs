use super::*;
use crate::memory::MemoryRecord;

/// Tool manifest for callers whose route has a configured group.
pub(super) const GROUP_MEMORY_TOOL_MANIFEST: &str = "\
Hivemind memory tools — at most one call per reply, as exactly one fenced block:\n\
```hivemind-tool\n\
{\"name\":\"memory.search\",\"args\":{\"query\":\"...\",\"scopes\":[\"group\",\"private\",\"persona\",\"global\",\"archive\"],\"limit\":8}}\n\
```\n\
\n\
Available tools: memory.search(query,scopes,limit) · memory.private.add(content) · memory.private.update(id,content) · memory.private.upsert(key,content) · memory.group.add(content) · memory.group.update(id,content) · memory.group.upsert(key,content) · memory.persona.propose(content) · memory.persona.update(id,content) · memory.global.propose(content) · memory.global.update(id,content) · memory.archive(id)\n\
Hivemind binds every call to your current room, group, instance, and persona — never send scope or owner ids. private = this instance only; group = your room's group; persona and global memories have far broader visibility across Hivemind, so those writes are proposals subject to stricter deterministic validation. memory.global.propose and memory.global.update are accepted only when their content exactly matches the trimmed payload of a `Global:` directive in the current user turn; every other global write is rejected.\n\
Rule: search first. If a result matches, revise it with the matching update tool using the `#id` shown in results (drop the leading #), or use upsert with a short stable `key` (e.g. \"timezone\"); add only when nothing matches. Archive results are room messages and have no id to update. Never invent results. A tool call must be your entire reply: emit exactly one fenced block as the last thing you write, with no other tool calls (including todo tools) in that reply; the result arrives in the next message.\n";

/// Tool manifest for groupless callers (main and solo rooms): no group tools or scope.
pub(super) const ROOM_MEMORY_TOOL_MANIFEST: &str = "\
Hivemind memory tools — at most one call per reply, as exactly one fenced block:\n\
```hivemind-tool\n\
{\"name\":\"memory.search\",\"args\":{\"query\":\"...\",\"scopes\":[\"private\",\"persona\",\"global\",\"archive\"],\"limit\":8}}\n\
```\n\
\n\
Available tools: memory.search(query,scopes,limit) · memory.private.add(content) · memory.private.update(id,content) · memory.private.upsert(key,content) · memory.persona.propose(content) · memory.persona.update(id,content) · memory.global.propose(content) · memory.global.update(id,content) · memory.archive(id)\n\
Hivemind binds every call to your current room, instance, and persona — never send scope or owner ids. This room has no group, so there is no group memory; never claim to have saved group memory. private = this instance only; persona and global memories have far broader visibility across Hivemind, so those writes are proposals subject to stricter deterministic validation. memory.global.propose and memory.global.update are accepted only when their content exactly matches the trimmed payload of a `Global:` directive in the current user turn; every other global write is rejected.\n\
Rule: search first. If a result matches, revise it with the matching update tool using the `#id` shown in results (drop the leading #), or use upsert with a short stable `key` (e.g. \"timezone\"); add only when nothing matches. Archive results are room messages and have no id to update. Never invent results. A tool call must be your entire reply: emit exactly one fenced block as the last thing you write, with no other tool calls (including todo tools) in that reply; the result arrives in the next message.\n";

/// Hivemind-generated tool manifest; never persona-specific. Group tools
/// appear only when the route has a configured group, mirroring
/// `default_search_scopes`.
pub(super) fn memory_tool_manifest(caller: &Caller) -> &'static str {
    if caller.group_id.is_empty() {
        ROOM_MEMORY_TOOL_MANIFEST
    } else {
        GROUP_MEMORY_TOOL_MANIFEST
    }
}

/// Memory actions allowed per agent invocation before a plain-text answer is required.
pub(super) const MAX_MEMORY_ACTIONS: usize = 4;

/// A parsed model tool request: a name from the fixed allowlist and its args.
/// Scope, room, group, instance, persona, and actor are never read from here.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct MemoryToolCall {
    pub(super) name: String,
    pub(super) args: serde_json::Value,
}

/// Extract exactly one `hivemind-tool` call from an assistant reply: a
/// ```` ```hivemind-tool ```` fence, or the `<hivemind-tool>…</hivemind-tool>`
/// tags some models emit instead. `Ok(None)` means a normal text answer;
/// malformed or ambiguous output is an error the loop feeds back to the agent
/// instead of guessing an action.
pub(super) fn parse_tool_block(text: &str) -> Result<Option<MemoryToolCall>> {
    const OPEN_TAG: &str = "<hivemind-tool>";
    const CLOSE_TAG: &str = "</hivemind-tool>";
    #[derive(PartialEq)]
    enum Open {
        No,
        Fence,
        Tag,
    }
    let mut blocks = Vec::new();
    let mut open = Open::No;
    let mut buffer = String::new();
    for line in text.lines() {
        let trimmed = line.trim();
        match open {
            Open::No if trimmed == "```hivemind-tool" => {
                open = Open::Fence;
                buffer.clear();
            }
            Open::No => {
                if let Some(rest) = trimmed.strip_prefix(OPEN_TAG) {
                    if let Some(body) = rest.strip_suffix(CLOSE_TAG) {
                        blocks.push(body.to_owned());
                    } else {
                        open = Open::Tag;
                        buffer.clear();
                        buffer.push_str(rest);
                        buffer.push('\n');
                    }
                }
            }
            Open::Fence if trimmed == "```" => {
                open = Open::No;
                blocks.push(std::mem::take(&mut buffer));
            }
            Open::Tag if trimmed.ends_with(CLOSE_TAG) => {
                open = Open::No;
                buffer.push_str(&trimmed[..trimmed.len() - CLOSE_TAG.len()]);
                blocks.push(std::mem::take(&mut buffer));
            }
            Open::Fence | Open::Tag => {
                buffer.push_str(line);
                buffer.push('\n');
            }
        }
    }
    if open != Open::No {
        bail!("unterminated hivemind-tool block");
    }
    match blocks.len() {
        0 => Ok(None),
        1 => {
            let value: serde_json::Value = serde_json::from_str(&blocks[0])
                .context("hivemind-tool block is not valid JSON")?;
            let object = value
                .as_object()
                .context("hivemind-tool block must be a JSON object")?;
            let name = object
                .get("name")
                .and_then(serde_json::Value::as_str)
                .filter(|name| !name.is_empty())
                .context("hivemind-tool block requires a non-empty string name")?;
            let args = match object.get("args") {
                None | Some(serde_json::Value::Null) => serde_json::json!({}),
                Some(args) if args.is_object() => args.clone(),
                Some(_) => bail!("hivemind-tool args must be a JSON object"),
            };
            Ok(Some(MemoryToolCall {
                name: name.to_owned(),
                args,
            }))
        }
        count => bail!("expected exactly one hivemind-tool block, found {count}"),
    }
}

pub(super) fn required_string(args: &serde_json::Value, key: &str) -> Result<String> {
    args.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .with_context(|| format!("tool argument '{key}' must be a non-empty string"))
}

pub(super) fn optional_string(args: &serde_json::Value, key: &str) -> Result<Option<String>> {
    match args.get(key) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(value) => value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| Some(value.to_owned()))
            .with_context(|| format!("tool argument '{key}' must be a string")),
    }
}

/// Build a write from tool args only; provenance comes exclusively from the
/// server-stamped caller (Hivemind), never from the model payload.
pub(super) fn tool_write(args: &serde_json::Value, target: Option<String>) -> Result<MemoryWrite> {
    let importance = match args.get("importance") {
        None | Some(serde_json::Value::Null) => 50,
        Some(value) => value
            .as_u64()
            .filter(|value| *value <= 100)
            .map(|value| value as u8)
            .context("tool argument 'importance' must be an integer from 0 to 100")?,
    };
    Ok(MemoryWrite {
        id: target,
        kind: optional_string(args, "kind")?.unwrap_or_else(|| "note".into()),
        content: required_string(args, "content")?,
        provenance: Provenance::default(),
        importance,
        supersedes_memory_id: None,
    })
}

pub(super) fn parse_scope_alias(alias: &str) -> Result<SearchScope> {
    Ok(match alias {
        "group" | "current_group" => SearchScope::Group,
        "private" | "instance" | "current_instance" => SearchScope::Instance,
        "persona" => SearchScope::Persona,
        "global" | "hivemind" => SearchScope::Global,
        "archive" | "current_room" => SearchScope::Archive,
        _ => bail!("unknown search scope '{alias}'"),
    })
}

/// Scopes this caller is authorized to search: group only when the route has
/// a configured group; the rest always resolve to the caller's own identity.
pub(super) fn default_search_scopes(caller: &Caller) -> Vec<SearchScope> {
    let mut scopes = Vec::new();
    if !caller.group_id.is_empty() {
        scopes.push(SearchScope::Group);
    }
    scopes.extend([
        SearchScope::Instance,
        SearchScope::Persona,
        SearchScope::Global,
        SearchScope::Archive,
    ]);
    scopes
}

pub(super) fn layer_label(layer: Layer) -> &'static str {
    match layer {
        Layer::RecentConversation => "recent",
        Layer::Group => "group",
        Layer::Private => "private",
        Layer::Persona => "persona",
        Layer::Global => "global",
        Layer::Archive => "archive",
    }
}

/// Bounded provenance suffix shared by `memory.search` tool output and the
/// context-pack retrieval section so both show where a result came from.
pub(super) fn source_suffix(provenance: &Provenance) -> String {
    let mut bits = Vec::new();
    for (label, value) in [
        ("room", provenance.source_room_id.as_deref()),
        ("turn", provenance.source_turn_id.as_deref()),
        ("message", provenance.source_message_id.as_deref()),
        ("actor", provenance.source_actor.as_deref()),
    ] {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            bits.push(format!("{label} {}", utf8_suffix(value, 80)));
        }
    }
    if bits.is_empty() {
        String::new()
    } else {
        format!(" (source: {})", bits.join(", "))
    }
}

/// `YYYY-MM-DD` (UTC) for a unix timestamp.
fn utc_date(secs: i64) -> String {
    let z = secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// One retrieval line shared by `memory.search` output and the context-pack
/// section. Durable memories show their updatable `#id`; archive hits are room
/// messages, not updatable memory, so they carry none.
pub(super) fn memory_result_line(record: &MemoryRecord) -> String {
    let content = utf8_suffix(&record.content, 300);
    let source = source_suffix(&record.provenance);
    if record.layer == Layer::Archive {
        return format!("- [archive] {content}{source}");
    }
    format!(
        "- [{}] #{} (updated {}) {content}{source}",
        layer_label(record.layer),
        record.id,
        utc_date(record.updated_at)
    )
}

/// Execute one parsed tool call against the shared MemoryService. The caller
/// is Hivemind-created; every scope decision happens inside the service.
pub(super) fn execute_memory_tool(
    memory: &MemoryService,
    caller: &Caller,
    call: &MemoryToolCall,
) -> Result<String> {
    match call.name.as_str() {
        "memory.search" => {
            let query = required_string(&call.args, "query")?;
            let scopes = match call.args.get("scopes") {
                None | Some(serde_json::Value::Null) => default_search_scopes(caller),
                Some(serde_json::Value::Array(items)) => {
                    if items.is_empty() {
                        bail!("search scopes must not be empty");
                    }
                    items
                        .iter()
                        .map(|item| {
                            item.as_str()
                                .context("search scopes must be strings")
                                .and_then(parse_scope_alias)
                        })
                        .collect::<Result<Vec<_>>>()?
                }
                Some(_) => bail!("search scopes must be an array of scope names"),
            };
            let limit = match call.args.get("limit") {
                None | Some(serde_json::Value::Null) => 8,
                Some(value) => value
                    .as_u64()
                    .filter(|value| (1..=32).contains(value))
                    .map(|value| value as usize)
                    .context("tool argument 'limit' must be an integer from 1 to 32")?,
            };
            let results = memory.search(
                caller,
                &SearchRequest {
                    query,
                    scopes,
                    limit,
                    include_historical: false,
                },
            )?;
            if results.is_empty() {
                return Ok("no memory results matched".to_owned());
            }
            let lines = results
                .iter()
                .map(|result| memory_result_line(&result.record))
                .collect::<Vec<_>>()
                .join("\n");
            Ok(format!("{} memory results:\n{lines}", results.len()))
        }
        "memory.private.add" => {
            let (record, existing) =
                memory.add_private_outcome(caller, tool_write(&call.args, None)?)?;
            Ok(if existing {
                format!("already stored as {}", record.id)
            } else {
                format!("stored private memory {}", record.id)
            })
        }
        "memory.private.update" => {
            let id = required_string(&call.args, "id")?;
            let record =
                memory.update_private(caller, &id, tool_write(&call.args, Some(id.clone()))?)?;
            Ok(format!("updated private memory {}", record.id))
        }
        "memory.private.upsert" => {
            let key = required_string(&call.args, "key")?;
            let (record, updated) =
                memory.upsert_private(caller, &key, tool_write(&call.args, None)?)?;
            Ok(format!(
                "{} private memory {} for key '{}'",
                if updated { "updated" } else { "stored" },
                record.id,
                key.to_lowercase()
            ))
        }
        "memory.group.add" => {
            let (record, existing) =
                memory.add_group_outcome(caller, tool_write(&call.args, None)?)?;
            Ok(if existing {
                format!("already stored as {}", record.id)
            } else {
                format!("stored group memory {}", record.id)
            })
        }
        "memory.group.update" => {
            let id = required_string(&call.args, "id")?;
            let record =
                memory.update_group(caller, &id, tool_write(&call.args, Some(id.clone()))?)?;
            Ok(format!("updated group memory {}", record.id))
        }
        "memory.group.upsert" => {
            let key = required_string(&call.args, "key")?;
            let (record, updated) =
                memory.upsert_group(caller, &key, tool_write(&call.args, None)?)?;
            Ok(format!(
                "{} group memory {} for key '{}'",
                if updated { "updated" } else { "stored" },
                record.id,
                key.to_lowercase()
            ))
        }
        "memory.persona.update" => {
            let id = required_string(&call.args, "id")?;
            let record =
                memory.update_persona(caller, &id, tool_write(&call.args, Some(id.clone()))?)?;
            Ok(format!(
                "updated persona memory {} after deterministic policy checks",
                record.id
            ))
        }
        "memory.global.update" => {
            let id = required_string(&call.args, "id")?;
            let record =
                memory.update_global(caller, &id, tool_write(&call.args, Some(id.clone()))?)?;
            Ok(format!(
                "updated global memory {} after deterministic policy checks",
                record.id
            ))
        }
        "memory.persona.propose" => {
            let record = memory.propose_persona(caller, tool_write(&call.args, None)?)?;
            Ok(format!(
                "accepted persona memory {} after deterministic policy checks",
                record.id
            ))
        }
        "memory.global.propose" => {
            let record = memory.propose_global(caller, tool_write(&call.args, None)?)?;
            Ok(format!(
                "accepted global memory {} after deterministic policy checks",
                record.id
            ))
        }
        "memory.archive" => {
            let id = required_string(&call.args, "id")?;
            memory.archive(caller, &id)?;
            Ok(format!("archived memory {id}"))
        }
        other => bail!("unknown memory tool '{other}'"),
    }
}

/// Self-contained re-prompt used when the runtime must (re)hydrate mid-turn:
/// the context pack plus this turn's full tool exchange.
pub(super) fn tool_prompt(pack: &str, exchange: &[(String, String)]) -> String {
    if exchange.is_empty() {
        return pack.to_owned();
    }
    let mut prompt = String::with_capacity(pack.len() + 256);
    prompt.push_str(pack);
    prompt.push_str("\nMemory tool exchange this turn:\n");
    for (call, result) in exchange {
        prompt.push_str(&format!("- requested: {call}\n- result: {result}\n"));
    }
    prompt.push_str(
        "Respond with either exactly one ```hivemind-tool fenced block or the final answer as plain text.\n",
    );
    prompt
}

/// Continuation prompt for a live session that already holds the pack and
/// this turn's earlier exchange: only the latest tool result.
pub(super) fn tool_followup(call: &str, result: &str) -> String {
    format!("Memory tool result:\n- requested: {call}\n- result: {result}\nRespond with either exactly one ```hivemind-tool fenced block or the final answer as plain text.\n")
}

/// Server-created invocation context for one agent, one turn: identity and
/// provenance come from the room/turn Hivemind is executing — never from
/// model-supplied tool arguments.
pub(super) fn invocation_caller(
    room: &str,
    group_id: &str,
    persona_id: &str,
    turn_id: &str,
    message_id: &str,
) -> Caller {
    Caller::agent(
        room,
        group_id,
        AgentInstanceId::new(room, persona_id),
        persona_id,
        persona_id,
    )
    .with_provenance(Provenance {
        source_room_id: Some(room.to_owned()),
        source_turn_id: Some(turn_id.to_owned()),
        source_message_id: Some(message_id.to_owned()),
        source_actor: Some(persona_id.to_owned()),
        source_kind: Some("agent_proposal".into()),
    })
}

/// Host-created caller for user-directed turn side effects (explicit
/// directives in user input): provenance is a structured project event from
/// the user, never an agent proposal. An empty `persona` builds the
/// room/group host caller used for group-state writes; otherwise the caller
/// is bound to that persona's instance so private writes stay in scope.
pub(super) fn user_directive_caller(
    room: &str,
    group_id: &str,
    persona: &str,
    turn_id: &str,
    message_id: &str,
) -> Caller {
    let instance_id = AgentInstanceId::new(room, persona);
    Caller::agent(room, group_id, instance_id, persona, "user").with_provenance(Provenance {
        source_room_id: Some(room.to_owned()),
        source_turn_id: Some(turn_id.to_owned()),
        source_message_id: Some(message_id.to_owned()),
        source_actor: Some("user".to_owned()),
        source_kind: Some("structured_project_event".into()),
    })
}

/// Keep exactly one active L4 `kind=assignment` note per persona: update the
/// existing active note in place (which logs a revision) and archive any
/// other stale active assignment notes instead of accumulating them.
pub(super) fn replace_active_assignment(
    memory: &MemoryService,
    assignee: &Caller,
    note: MemoryWrite,
) -> Result<()> {
    let scope = Scope::AgentInstance(assignee.agent_instance_id.clone());
    let mut active: Vec<_> = memory
        .store()
        .records_in_scope(assignee, &scope)?
        .into_iter()
        .filter(|record| record.kind == "assignment" && record.status == MemoryStatus::Active)
        .collect();
    if active.is_empty() {
        memory.add_private(assignee, note)?;
        return Ok(());
    }
    active.sort_by(|left, right| left.id.cmp(&right.id));
    let first = active.remove(0);
    memory.update_private(assignee, &first.id, note)?;
    for stale in active {
        memory.archive(assignee, &stale.id)?;
    }
    Ok(())
}

/// Explicit structured user directive authorizing one exact global memory
/// proposal for this turn: an input line starting with `Global:` (for
/// example `Global: Hivemind architecture: runtimes are disposable`).
/// Parsed ONLY from raw user input — never from agent replies or broad
/// prompt wording — so a model cannot self-authorize; the exact trimmed
/// payload is bound in the authorization builder.
pub(super) fn authorized_global_directive(input: &str) -> Option<String> {
    input
        .lines()
        .find_map(|line| line.trim().strip_prefix("Global:"))
        .map(str::trim)
        .filter(|content| !content.is_empty())
        .map(str::to_owned)
}

/// Execute one tool call, upgrading the caller only when a `Global:`
/// user directive from THIS turn authorizes the exact proposed content.
/// Authorization is built solely from the host-parsed directive and the
/// Hivemind invocation provenance — never from model/tool arguments.
pub(super) fn execute_with_optional_authorization(
    memory: &MemoryService,
    caller: &Caller,
    authorized_global: Option<&str>,
    call: &MemoryToolCall,
) -> Result<String> {
    let exact = authorized_global.filter(|exact| {
        matches!(
            call.name.as_str(),
            "memory.global.propose" | "memory.global.update"
        ) && call
            .args
            .get("content")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            == Some(exact.trim())
    });
    if let Some(exact) = exact {
        let authorized = caller.clone().authorize_global_proposal_from_user_event(
            exact.to_owned(),
            Provenance {
                source_room_id: caller.provenance.source_room_id.clone(),
                source_turn_id: caller.provenance.source_turn_id.clone(),
                source_message_id: caller.provenance.source_message_id.clone(),
                source_actor: Some("user".to_owned()),
                source_kind: Some("explicit_user_instruction".to_owned()),
            },
        )?;
        return execute_memory_tool(memory, &authorized, call);
    }
    execute_memory_tool(memory, caller, call)
}

/// Adapter-independent memory tool loop: run the invoker, execute at most
/// [`MAX_MEMORY_ACTIONS`] Hivemind tool actions, re-prompt with each result,
/// and return the first plain-text answer. The first prompt may be a room
/// delta bound to the live runtime epoch; each follow-up carries only the
/// latest tool result bound to the epoch that produced the previous reply,
/// with the self-contained pack-plus-exchange prompt as the fallback whenever
/// the runtime must rehydrate.
#[allow(clippy::too_many_arguments)]
pub(super) async fn invoke_with_memory(
    invoker: &dyn AgentInvoker,
    instance_id: &AgentInstanceId,
    agent: &AgentConfig,
    pack: &str,
    delta: Option<PromptDelta<'_>>,
    view: &TurnView,
    caller: &Caller,
    memory: &MemoryService,
    authorized_global: Option<&str>,
    host: Option<&dyn ToolHost>,
    access: Option<&crate::access::AccessPolicy>,
) -> Result<String> {
    let mut exchange: Vec<(String, String)> = Vec::new();
    let mut last = invoker
        .invoke(InvokeRequest {
            agent_instance_id: instance_id,
            agent,
            phase: PromptPhase::TurnStart,
            full: pack,
            delta,
            view,
        })
        .await?;
    let mut actions = 0usize;
    loop {
        let reply = &last.text;
        let call = match parse_tool_block(reply) {
            Ok(None) => return Ok(last.text),
            Ok(Some(call)) => Ok(call),
            Err(error) => Err(format!("{error:#}")),
        };
        let limit = host.map_or(MAX_MEMORY_ACTIONS, |host| host.max_actions(&caller.room_id));
        if actions >= limit {
            bail!(
                "agent hit the Hivemind memory tool action limit ({limit}) without producing a plain-text answer"
            );
        }
        actions += 1;
        let (rendered, result) = match call {
            Ok(call) => {
                let rendered = serde_json::to_string(&call.args)
                    .map(|args| format!("{{\"name\":\"{}\",\"args\":{args}}}", call.name))
                    .unwrap_or_else(|_| call.name.clone());
                let executed = match host.filter(|host| host.handles(&call.name)) {
                    Some(host) => {
                        host.execute(&caller.room_id, &caller.persona_id, &call.name, &call.args)
                    }
                    None => access
                        .map_or(Ok(()), |access| {
                            access.authorize_memory(&caller.persona_id, &caller.room_id, &call.name)
                        })
                        .and_then(|()| {
                            execute_with_optional_authorization(
                                memory,
                                caller,
                                authorized_global,
                                &call,
                            )
                        }),
                };
                match executed {
                    Ok(text) => (rendered, text),
                    Err(error) => (rendered, format!("error: {error:#}")),
                }
            }
            Err(error) => (utf8_suffix(reply, 400), format!("error: {error}")),
        };
        let followup = tool_followup(&rendered, &result);
        exchange.push((rendered, result));
        let full = tool_prompt(pack, &exchange);
        last = invoker
            .invoke(InvokeRequest {
                agent_instance_id: instance_id,
                agent,
                phase: PromptPhase::InTurn,
                full: &full,
                delta: Some(PromptDelta {
                    epoch_id: &last.epoch_id,
                    text: &followup,
                }),
                view,
            })
            .await?;
    }
}
