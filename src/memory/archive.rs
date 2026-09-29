use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use crate::identity::AgentInstanceId;

use super::{ArchivedMessage, RuntimeEpoch};

pub(super) fn upsert_archive_message(c: &Connection, message: &ArchivedMessage) -> Result<()> {
    let turn_room: Option<String> = c
        .query_row(
            "SELECT room_id FROM archive_turns WHERE id=?1",
            [&message.turn_id],
            |r| r.get(0),
        )
        .optional()?;
    if turn_room.as_deref() != Some(message.room_id.as_str()) {
        bail!("message turn does not belong to its room");
    }
    let existing_message_room: Option<String> = c
        .query_row(
            "SELECT room_id FROM archive_messages WHERE id=?1",
            [&message.id],
            |r| r.get(0),
        )
        .optional()?;
    if existing_message_room
        .as_deref()
        .is_some_and(|room| room != message.room_id)
    {
        bail!("message id is already owned by another room");
    }
    c.execute("DELETE FROM archive_fts WHERE id=?1", [&message.id])?;
    c.execute("INSERT INTO archive_messages(id,room_id,turn_id,speaker,content,created_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET room_id=excluded.room_id,turn_id=excluded.turn_id,speaker=excluded.speaker,content=excluded.content,created_at=excluded.created_at",params![message.id,message.room_id,message.turn_id,message.speaker,message.content,message.created_at])?;
    c.execute(
        "INSERT INTO archive_fts(id,room_id,turn_id,speaker,content) VALUES(?1,?2,?3,?4,?5)",
        params![
            message.id,
            message.room_id,
            message.turn_id,
            message.speaker,
            message.content
        ],
    )?;
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

pub(super) fn load_runtime_epoch(c: &Connection, id: &str) -> Result<Option<RuntimeEpoch>> {
    c.query_row(
        "SELECT id,room_id,instance_id,runtime,started_at,ended_at,metadata_json FROM runtime_epochs WHERE id=?1 AND identity_version=1",
        [id],
        |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?,r.get::<_,Option<i64>>(5)?,r.get::<_,String>(6)?)),
    ).optional()?
      .map(|(id,room_id,instance_id,runtime,started_at,ended_at,metadata)| Ok(RuntimeEpoch {
          id, agent_instance_id: decode_agent_instance_id(&room_id, &instance_id)?,
          room_id, runtime, started_at, ended_at,
          metadata: serde_json::from_str(&metadata).context("decoding runtime epoch metadata")?,
      })).transpose()
}
