use std::fmt::Write;

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::identity::AgentInstanceId;

use super::{ArchivedMessage, RuntimeEpoch};

/// Single FTS token identifying `value` exactly (`prefix` + uppercase hex of
/// its UTF-8 bytes). Mirrors SQL `prefix || hex(value)` used by the migration,
/// so a column-filtered MATCH scopes a query to one room/scope inside FTS.
pub(super) fn hex_key(prefix: char, value: &str) -> String {
    let mut out = String::with_capacity(1 + value.len() * 2);
    out.push(prefix);
    for byte in value.as_bytes() {
        let _ = write!(out, "{byte:02X}");
    }
    out
}

pub(super) fn message_from_row(r: &Row<'_>) -> rusqlite::Result<ArchivedMessage> {
    Ok(ArchivedMessage {
        id: r.get(0)?,
        room_id: r.get(1)?,
        turn_id: r.get(2)?,
        speaker: r.get(3)?,
        content: r.get(4)?,
        created_at: r.get(5)?,
    })
}

/// Insert or update one archive message and keep its rowid-aligned FTS row in
/// sync. The turn must already exist and belong to the message's room.
pub(super) fn upsert_archive_message(c: &Connection, message: &ArchivedMessage) -> Result<()> {
    let turn_room: Option<String> = c
        .prepare_cached("SELECT room_id FROM archive_turns WHERE id=?1")?
        .query_row([&message.turn_id], |r| r.get(0))
        .optional()?;
    if turn_room.as_deref() != Some(message.room_id.as_str()) {
        bail!("message turn does not belong to its room");
    }
    let rowid: Option<i64> = c
        .prepare_cached("INSERT INTO archive_messages(id,room_id,turn_id,speaker,content,created_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET turn_id=excluded.turn_id,speaker=excluded.speaker,content=excluded.content,created_at=excluded.created_at WHERE archive_messages.room_id=excluded.room_id RETURNING rowid")?
        .query_row(
            params![message.id, message.room_id, message.turn_id, message.speaker, message.content, message.created_at],
            |r| r.get(0),
        )
        .optional()?;
    let Some(rowid) = rowid else {
        bail!("message id is already owned by another room");
    };
    c.prepare_cached("DELETE FROM archive_fts WHERE rowid=?1")?
        .execute([rowid])?;
    c.prepare_cached("INSERT INTO archive_fts(rowid,room_key,speaker,content) VALUES(?1,?2,?3,?4)")?
        .execute(params![rowid, hex_key('r', &message.room_id), message.speaker, message.content])?;
    Ok(())
}

pub(super) fn decode_agent_instance_id(room_id: &str, stored: &str) -> Result<AgentInstanceId> {
    if let Some(identity) = AgentInstanceId::decode(stored) {
        if identity.room_id != room_id {
            bail!("runtime epoch identity room does not match its room");
        }
        return Ok(identity);
    }

    Err(anyhow!(
        "legacy runtime epoch identities are opaque and cannot be decoded safely"
    ))
}

type RawEpoch = (String, String, String, String, i64, Option<i64>, String);

pub(super) fn raw_epoch(r: &Row<'_>) -> rusqlite::Result<RawEpoch> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
}

pub(super) fn decode_epoch(raw: RawEpoch) -> Result<RuntimeEpoch> {
    let (id, room_id, instance_id, runtime, started_at, ended_at, metadata) = raw;
    Ok(RuntimeEpoch {
        id,
        agent_instance_id: decode_agent_instance_id(&room_id, &instance_id)?,
        room_id,
        runtime,
        started_at,
        ended_at,
        metadata: serde_json::from_str(&metadata).context("decoding runtime epoch metadata")?,
    })
}

pub(super) fn load_runtime_epoch(c: &Connection, id: &str) -> Result<Option<RuntimeEpoch>> {
    c.prepare_cached(
        "SELECT id,room_id,instance_id,runtime,started_at,ended_at,metadata_json FROM runtime_epochs WHERE id=?1 AND identity_version=1",
    )?
    .query_row([id], raw_epoch)
    .optional()?
    .map(decode_epoch)
    .transpose()
}

pub(super) fn touch_room(c: &Connection, room_id: &str, updated_at: i64) -> Result<()> {
    c.prepare_cached("INSERT INTO rooms(id,name,updated_at) VALUES(?1,'',?2) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at")?
        .execute(params![room_id, updated_at])?;
    Ok(())
}
