use super::*;

pub(super) fn append_unique(values: &mut Vec<String>, value: &str) {
    if !values.iter().any(|existing| existing == value) {
        values.push(value.to_owned());
    }
}

/// Apply only documented user-input directives, never successful agent prose.
pub(super) fn apply_explicit_state_updates(state: &mut RoomState, text: &str) -> Result<()> {
    // A host-authored wakeup re-enters the room with the agent's own words.
    // They are not user directives, so the wakeup is skipped entirely.
    if crate::wakeup::is_wakeup_message(text) {
        return Ok(());
    }
    for line in text.lines().map(str::trim) {
        let Some((field, value)) = [
            ("Goal:", "goal"),
            ("Decision:", "decision"),
            ("Assign:", "assignment"),
            ("Question:", "question"),
            ("Completed:", "completed"),
        ]
        .into_iter()
        .find_map(|(prefix, field)| line.strip_prefix(prefix).map(|value| (field, value))) else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            bail!("state directive '{field}' must not be empty");
        }
        match field {
            "goal" => state.goal = Some(value.to_owned()),
            "decision" => append_unique(&mut state.decisions, value),
            "assignment" => {
                let Some((owner, assignment)) = value.split_once('=') else {
                    bail!("Assign directive must use 'Assign: persona = task'");
                };
                let owner = owner.trim();
                let assignment = assignment.trim();
                if owner.is_empty() || assignment.is_empty() {
                    bail!("Assign directive persona and task must not be empty");
                }
                state
                    .assignments
                    .insert(owner.to_owned(), assignment.to_owned());
            }
            "question" => append_unique(&mut state.open_questions, value),
            "completed" => append_unique(&mut state.completed, value),
            _ => unreachable!("directive field is selected from the fixed list"),
        }
    }
    Ok(())
}

pub(super) fn validate_state(state: &RoomState, max_serialized_bytes: usize) -> Result<()> {
    if state.decisions.len() > 128
        || state.assignments.len() > 128
        || state.open_questions.len() > 128
        || state.completed.len() > 128
    {
        bail!("room state may contain at most 128 entries per list or map");
    }
    let values = state
        .goal
        .iter()
        .chain(state.decisions.iter())
        .chain(state.assignments.keys())
        .chain(state.assignments.values())
        .chain(state.open_questions.iter())
        .chain(state.completed.iter());
    if values.into_iter().any(|value| value.len() > 16_384) {
        bail!("room state field exceeds 16384 bytes");
    }
    if serde_json::to_vec(state)?.len() > max_serialized_bytes {
        bail!("serialized room state exceeds context budget limit of {max_serialized_bytes} bytes");
    }
    Ok(())
}

pub(super) fn record_maintenance_error(history: &mut RoomHistory, message: String) {
    eprintln!("hivemind: {message}");
    history.maintenance_errors.push(message);
    if history.maintenance_errors.len() > 64 {
        history.maintenance_errors.remove(0);
    }
}

pub(super) fn append_reply(
    history: &mut RoomHistory,
    room: &str,
    turn_id: &str,
    speaker: &str,
    result: &Result<String, String>,
) {
    history.events.push(MessageEvent {
        id: stable_id(),
        turn_id: turn_id.to_owned(),
        speaker: speaker.to_owned(),
        agent_instance_id: Some(crate::identity::AgentInstanceId::new(room, speaker)),
        legacy_agent_instance_id: None,
        content: result
            .clone()
            .unwrap_or_else(|error| format!("[agent failure: {error}]")),
        error: result.is_err(),
    });
}

/// Events of the last `turns` turns before `active_turn`. A turn's events are
/// contiguous, so the window is found by walking back from the end.
pub(super) fn recent_events(events: &[MessageEvent], turns: usize, active_turn: &str) -> String {
    if turns == 0 {
        return String::new();
    }
    let mut seen = 0;
    let mut last: Option<&str> = None;
    let mut start = events.len();
    for (index, event) in events.iter().enumerate().rev() {
        if event.turn_id == active_turn {
            continue;
        }
        if last != Some(event.turn_id.as_str()) {
            if seen == turns {
                break;
            }
            seen += 1;
            last = Some(event.turn_id.as_str());
        }
        start = index;
    }
    events[start..]
        .iter()
        .filter(|event| event.turn_id != active_turn)
        .map(|event| format!("{}: {}", event.speaker, event.content))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn utf8_suffix(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_owned();
    }
    let mut start = text.len() - max_bytes;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_owned()
}

pub(super) fn stable_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // Time-first, fixed-width ids keep archive ordering deterministic across
    // processes and let the SQLite archive recover a message timestamp.
    format!("{nanos:020}-{sequence:06}-{}", std::process::id())
}

/// Seconds embedded in an id created by [`stable_id`]; legacy or unknown ids
/// fall back to "now" so they never sort before established history.
pub(super) fn id_timestamp(id: &str) -> i64 {
    let parsed = id
        .split('-')
        .next()
        .and_then(|first| first.parse::<u64>().ok())
        .map(|nanos| nanos / 1_000_000_000);
    match parsed {
        Some(seconds) if seconds > 0 => seconds as i64,
        _ => SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
    }
}
