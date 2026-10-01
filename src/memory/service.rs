use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, OptionalExtension};

use super::{policy::*, store::MemoryStore, *};
/// Policy-checked operations exposed to the future single tool bridge.
pub struct MemoryService {
    store: MemoryStore,
}
impl MemoryService {
    pub fn new(store: MemoryStore) -> Self {
        Self { store }
    }
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Ok(Self::new(MemoryStore::open(path)?))
    }
    pub fn store(&self) -> &MemoryStore {
        &self.store
    }
    pub fn add_private(&self, caller: &Caller, write: MemoryWrite) -> Result<MemoryRecord> {
        Ok(self.add_private_outcome(caller, write)?.0)
    }
    /// Like [`Self::add_private`]; the flag is `true` when an identical active
    /// record already existed and was returned (with `updated_at` bumped).
    pub fn add_private_outcome(
        &self,
        caller: &Caller,
        write: MemoryWrite,
    ) -> Result<(MemoryRecord, bool)> {
        self.accept(
            caller,
            Scope::AgentInstance(caller.agent_instance_id.clone()),
            Layer::Private,
            write,
            false,
            true,
            None,
        )
    }
    pub fn add_group(&self, caller: &Caller, write: MemoryWrite) -> Result<MemoryRecord> {
        Ok(self.add_group_outcome(caller, write)?.0)
    }
    pub fn add_group_outcome(
        &self,
        caller: &Caller,
        write: MemoryWrite,
    ) -> Result<(MemoryRecord, bool)> {
        self.accept(
            caller,
            Scope::Group(caller.group_id.clone()),
            Layer::Group,
            write,
            false,
            true,
            None,
        )
    }
    /// Update the active private record carrying `key` in this instance's
    /// scope, or insert one. The bool is `true` when an existing record was updated.
    pub fn upsert_private(
        &self,
        caller: &Caller,
        key: &str,
        write: MemoryWrite,
    ) -> Result<(MemoryRecord, bool)> {
        self.upsert(
            caller,
            Scope::AgentInstance(caller.agent_instance_id.clone()),
            Layer::Private,
            key,
            write,
        )
    }
    pub fn upsert_group(
        &self,
        caller: &Caller,
        key: &str,
        write: MemoryWrite,
    ) -> Result<(MemoryRecord, bool)> {
        if caller.group_id.is_empty() {
            bail!("group memory requires an authorized group");
        }
        self.upsert(
            caller,
            Scope::Group(caller.group_id.clone()),
            Layer::Group,
            key,
            write,
        )
    }
    fn upsert(
        &self,
        caller: &Caller,
        scope: Scope,
        layer: Layer,
        key: &str,
        write: MemoryWrite,
    ) -> Result<(MemoryRecord, bool)> {
        let key = key.trim().to_lowercase();
        if key.is_empty() || key.chars().count() > 100 {
            bail!("memory key must be 1 to 100 characters");
        }
        if let Some(id) = self.store.find_active_by_key(&scope, &key)? {
            return Ok((self.update(caller, &id, write, layer)?, true));
        }
        self.accept(caller, scope, layer, write, false, false, Some(&key))
            .map(|(record, _)| (record, false))
    }
    pub fn propose_persona(&self, caller: &Caller, write: MemoryWrite) -> Result<MemoryRecord> {
        Ok(self
            .accept(
                caller,
                Scope::Persona(caller.persona_id.clone()),
                Layer::Persona,
                write,
                true,
                false,
                None,
            )?
            .0)
    }
    pub fn propose_global(&self, caller: &Caller, write: MemoryWrite) -> Result<MemoryRecord> {
        Ok(self
            .accept(
                caller,
                Scope::Hivemind,
                Layer::Global,
                write,
                true,
                false,
                None,
            )?
            .0)
    }
    /// Insert a record. With `dedup`, an identical active record in the same
    /// scope and layer (whitespace/case-normalized) is returned instead, with
    /// `updated_at` bumped; the bool marks that case.
    #[allow(clippy::too_many_arguments)]
    fn accept(
        &self,
        caller: &Caller,
        scope: Scope,
        layer: Layer,
        mut write: MemoryWrite,
        broad: bool,
        dedup: bool,
        topic_key: Option<&str>,
    ) -> Result<(MemoryRecord, bool)> {
        if !caller.trusted
            && (caller.room_id.is_empty()
                || caller.agent_instance_id.room_id != caller.room_id
                || caller.agent_instance_id.persona_id != caller.persona_id
                || caller.persona_id.is_empty()
                || caller.actor.is_empty())
        {
            bail!("caller lacks server-established identity");
        }
        if matches!(&scope, Scope::Group(group) if group.is_empty()) {
            bail!("group memory requires an authorized group");
        }
        write.provenance = effective_provenance(caller, &write.content, write.provenance);
        validate_write(&write)?;
        if broad {
            validate_broad_proposal(caller, &scope, &write)?;
        }
        let timestamp = now();
        if dedup && write.id.is_none() && write.supersedes_memory_id.is_none() {
            if let Some(existing) = self.store.touch_duplicate(
                &scope,
                layer,
                &normalize_content(&write.content),
                timestamp,
            )? {
                return Ok((existing, true));
            }
        }
        let record = MemoryRecord {
            id: write.id.unwrap_or_else(new_id),
            layer,
            scope,
            kind: write.kind,
            content: write.content,
            provenance: normalized_provenance(caller, write.provenance),
            created_at: timestamp,
            updated_at: timestamp,
            status: MemoryStatus::Active,
            importance: write.importance.min(100),
            supersedes_memory_id: write.supersedes_memory_id,
        };
        self.store.insert_keyed(&record, topic_key)?;
        Ok((record, false))
    }
    pub fn archive(&self, caller: &Caller, id: &str) -> Result<()> {
        let r = self
            .store
            .load(id)?
            .ok_or_else(|| anyhow!("memory not found"))?;
        ensure_can_access(caller, &r.scope)?;
        if !caller.trusted && matches!(r.layer, Layer::Persona | Layer::Global) {
            bail!("only a trusted caller may archive persona or global memory");
        }
        self.store.set_status(id, MemoryStatus::Archived, &r.scope)
    }
    pub fn update_private(
        &self,
        caller: &Caller,
        id: &str,
        write: MemoryWrite,
    ) -> Result<MemoryRecord> {
        self.update(caller, id, write, Layer::Private)
    }
    pub fn update_group(
        &self,
        caller: &Caller,
        id: &str,
        write: MemoryWrite,
    ) -> Result<MemoryRecord> {
        self.update(caller, id, write, Layer::Group)
    }
    pub fn update_persona(
        &self,
        caller: &Caller,
        id: &str,
        write: MemoryWrite,
    ) -> Result<MemoryRecord> {
        self.update(caller, id, write, Layer::Persona)
    }
    pub fn update_global(
        &self,
        caller: &Caller,
        id: &str,
        write: MemoryWrite,
    ) -> Result<MemoryRecord> {
        self.update(caller, id, write, Layer::Global)
    }
    fn update(
        &self,
        caller: &Caller,
        id: &str,
        mut write: MemoryWrite,
        expected: Layer,
    ) -> Result<MemoryRecord> {
        write.provenance = effective_provenance(caller, &write.content, write.provenance);
        validate_write(&write)?;
        let mut record = self
            .store
            .load(id)?
            .ok_or_else(|| anyhow!("memory not found"))?;
        ensure_can_access(caller, &record.scope)?;
        if record.layer != expected {
            bail!("memory is not in the requested layer");
        }
        if matches!(expected, Layer::Persona | Layer::Global) {
            validate_broad_proposal(caller, &record.scope, &write)?;
        }
        record.kind = write.kind;
        record.content = write.content;
        record.importance = write.importance.min(100);
        record.provenance = normalized_provenance(caller, write.provenance);
        record.updated_at = now();
        self.store.update_record(&record, &caller.actor)?;
        Ok(record)
    }
    pub fn search(&self, caller: &Caller, request: &SearchRequest) -> Result<Vec<SearchResult>> {
        if request.scopes.is_empty() {
            bail!("at least one search scope is required");
        }
        if request.scopes.contains(&SearchScope::Group) && caller.group_id.is_empty()
            || request.scopes.contains(&SearchScope::Instance)
                && (caller.room_id.is_empty()
                    || caller.agent_instance_id.room_id != caller.room_id
                    || caller.agent_instance_id.persona_id.is_empty()
                    || caller.agent_instance_id.persona_id != caller.persona_id)
            || request.scopes.contains(&SearchScope::Persona) && caller.persona_id.is_empty()
            || request.scopes.contains(&SearchScope::Archive) && caller.room_id.is_empty()
        {
            bail!("caller lacks identity for requested scope");
        }
        self.store.search(caller, request)
    }
    /// Replace structured state for the caller's current group only.
    pub fn set_group_state(
        &self,
        caller: &Caller,
        state: serde_json::Value,
    ) -> Result<GroupStateRecord> {
        if caller.group_id.is_empty() {
            bail!("group state requires a current group");
        }
        let record = GroupStateRecord {
            group_id: caller.group_id.clone(),
            state,
            updated_at: now(),
            updated_by: caller.actor.clone(),
        };
        self.store.write(|c| {
            c.prepare_cached("INSERT INTO group_state(group_id,state_json,updated_at,updated_by) VALUES(?1,?2,?3,?4) ON CONFLICT(group_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by")?
                .execute(params![record.group_id,record.state.to_string(),record.updated_at,record.updated_by])?;
            Ok(())
        })?;
        Ok(record)
    }
    /// Read structured state from the caller's current group only.
    pub fn group_state(&self, caller: &Caller) -> Result<Option<GroupStateRecord>> {
        if caller.group_id.is_empty() {
            bail!("group state requires a current group");
        }
        let row = self.store.read(|c| {
            Ok(c.prepare_cached("SELECT group_id,state_json,updated_at,updated_by FROM group_state WHERE group_id=?1")?
                .query_row([&caller.group_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?)))
                .optional()?)
        })?;
        row.map(|(group_id, state, updated_at, updated_by)| {
            Ok(GroupStateRecord {
                group_id,
                state: serde_json::from_str(&state).context("decoding group state")?,
                updated_at,
                updated_by,
            })
        })
        .transpose()
    }
    /// Start a runtime epoch for this invocation's room and agent instance.
    pub fn start_runtime_epoch(
        &self,
        caller: &Caller,
        runtime: &str,
        metadata: serde_json::Value,
    ) -> Result<RuntimeEpoch> {
        if caller.room_id.is_empty()
            || caller.agent_instance_id.room_id != caller.room_id
            || caller.agent_instance_id.persona_id != caller.persona_id
            || runtime.trim().is_empty()
        {
            bail!("runtime epoch requires matching room, persona, and runtime identity");
        }
        let epoch = RuntimeEpoch {
            id: new_id(),
            room_id: caller.room_id.clone(),
            agent_instance_id: caller.agent_instance_id.clone(),
            runtime: runtime.into(),
            started_at: now(),
            ended_at: None,
            end_reason: None,
            metadata,
        };
        self.store.tx(|c| {
            touch_room(c, &epoch.room_id, epoch.started_at)?;
            c.prepare_cached("INSERT INTO runtime_epochs(id,room_id,instance_id,identity_version,runtime,started_at,ended_at,metadata_json) VALUES(?1,?2,?3,1,?4,?5,NULL,?6)")?
                .execute(params![epoch.id,epoch.room_id,epoch.agent_instance_id.encode(),epoch.runtime,epoch.started_at,epoch.metadata.to_string()])?;
            Ok(())
        })?;
        Ok(epoch)
    }
    /// Close an epoch only when it belongs to the caller's room and instance,
    /// recording why its session ended.
    pub fn end_runtime_epoch(
        &self,
        caller: &Caller,
        id: &str,
        ended_at: i64,
        reason: &str,
    ) -> Result<RuntimeEpoch> {
        if reason.trim().is_empty() {
            bail!("runtime epoch end requires a reason");
        }
        self.store.tx(|c| {
            let mut epoch =
                load_runtime_epoch(c, id)?.ok_or_else(|| anyhow!("runtime epoch not found"))?;
            if epoch.room_id != caller.room_id || epoch.agent_instance_id != caller.agent_instance_id {
                bail!("unauthorized runtime epoch");
            }
            if epoch.ended_at.is_some() || ended_at < epoch.started_at {
                bail!("runtime epoch is already closed or end time precedes start");
            }
            let changed = c
                .prepare_cached("UPDATE runtime_epochs SET ended_at=?1,end_reason=?3 WHERE id=?2 AND identity_version=1 AND ended_at IS NULL")?
                .execute(params![ended_at, id, reason])?;
            if changed != 1 {
                bail!("runtime epoch was concurrently closed");
            }
            epoch.ended_at = Some(ended_at);
            epoch.end_reason = Some(reason.to_owned());
            Ok(epoch)
        })
    }
    /// List only the caller's epochs, newest first, with an enforced bound.
    pub fn runtime_epochs(&self, caller: &Caller, limit: usize) -> Result<Vec<RuntimeEpoch>> {
        if caller.room_id.is_empty()
            || caller.agent_instance_id.room_id != caller.room_id
            || caller.agent_instance_id.persona_id != caller.persona_id
        {
            bail!("runtime epoch listing requires room and instance");
        }
        self.store.read(|c| {
            c.prepare_cached("SELECT id,room_id,instance_id,runtime,started_at,ended_at,end_reason,metadata_json FROM runtime_epochs WHERE room_id=?1 AND identity_version=1 AND instance_id=?2 ORDER BY started_at DESC,id DESC LIMIT ?3")?
                .query_map(
                    params![
                        caller.room_id,
                        caller.agent_instance_id.encode(),
                        limit.min(100) as i64
                    ],
                    raw_epoch,
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .map(decode_epoch)
                .collect()
        })
    }
    /// List every instance's epochs in `room_id`, oldest first, for trusted
    /// host callers (task observability); agents use [`Self::runtime_epochs`].
    pub fn room_runtime_epochs(
        &self,
        caller: &Caller,
        room_id: &str,
        limit: usize,
    ) -> Result<Vec<RuntimeEpoch>> {
        if !caller.trusted {
            bail!("listing a room's runtime epochs requires a trusted caller");
        }
        self.store.read(|c| {
            c.prepare_cached("SELECT id,room_id,instance_id,runtime,started_at,ended_at,end_reason,metadata_json FROM runtime_epochs WHERE room_id=?1 AND identity_version=1 ORDER BY started_at,id LIMIT ?2")?
                .query_map(params![room_id, limit.min(500) as i64], raw_epoch)?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .map(decode_epoch)
                .collect()
        })
    }
    /// Append canonical L7 room messages. This does not create/promote a memory record.
    pub fn append_room_message(&self, caller: &Caller, message: ArchivedMessage) -> Result<()> {
        if !caller.trusted && message.room_id != caller.room_id {
            bail!("cannot append a message outside the caller's room");
        }
        if message.id.is_empty()
            || message.room_id.is_empty()
            || message.turn_id.is_empty()
            || message.content.trim().is_empty()
            || message.speaker.trim().is_empty()
        {
            bail!("archive message requires id, room, turn, speaker, and content");
        }
        self.store.archive_message(&message)
    }
    /// Insert or upsert a complete L7 turn, participants, and messages atomically.
    pub fn append_archive_turn(&self, caller: &Caller, turn: ArchivedTurn) -> Result<()> {
        if !caller.trusted && turn.room_id != caller.room_id {
            bail!("cannot append a turn outside the caller's room");
        }
        if turn.id.is_empty() || turn.room_id.is_empty() {
            bail!("archive turn requires id and room");
        }
        if turn
            .participants
            .iter()
            .any(|p| p.participant_id.trim().is_empty())
        {
            bail!("archive participants require an id");
        }
        for message in &turn.messages {
            if message.id.is_empty()
                || message.speaker.trim().is_empty()
                || message.content.trim().is_empty()
            {
                bail!("archive messages require id, speaker, and content");
            }
            if message.room_id != turn.room_id || message.turn_id != turn.id {
                bail!("each archived message must belong to the supplied turn");
            }
        }
        self.store.archive_turn(&turn)
    }
    pub fn archive_turn(
        &self,
        caller: &Caller,
        room_id: &str,
        turn_id: &str,
    ) -> Result<Option<ArchivedTurn>> {
        if !caller.trusted && room_id != caller.room_id {
            bail!("cannot read another room archive");
        }
        self.store.read(|c| {
            let row = c.prepare_cached("SELECT id,room_id,started_at,completed_at,metadata FROM archive_turns WHERE id=?1 AND room_id=?2")?
                .query_row(
                    params![turn_id, room_id],
                    |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,Option<i64>>(3)?,r.get::<_,String>(4)?)),
                ).optional()?;
            let Some((id, room_id, started_at, completed_at, metadata)) = row else {
                return Ok(None);
            };
            let metadata =
                serde_json::from_str(&metadata).context("decoding archived turn metadata")?;
            let participants = c
                .prepare_cached("SELECT participant_id,role FROM archive_participants WHERE turn_id=?1 ORDER BY participant_id")?
                .query_map([turn_id], |r| {
                    Ok(ArchiveParticipant {
                        participant_id: r.get(0)?,
                        role: r.get(1)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let messages = c
                .prepare_cached("SELECT id,room_id,turn_id,speaker,content,created_at FROM archive_messages WHERE turn_id=?1 ORDER BY created_at,id")?
                .query_map([turn_id], message_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(Some(ArchivedTurn {
                id,
                room_id,
                started_at,
                completed_at,
                metadata,
                participants,
                messages,
            }))
        })
    }
    pub fn recent_messages(
        &self,
        caller: &Caller,
        room_id: &str,
        turn_limit: usize,
    ) -> Result<Vec<ArchivedMessage>> {
        if !caller.trusted && room_id != caller.room_id {
            bail!("cannot read another room archive");
        }
        self.store.read(|c| {
            let mut q = c.prepare_cached("SELECT id,room_id,turn_id,speaker,content,created_at FROM archive_messages WHERE room_id=?1 ORDER BY created_at DESC,id DESC")?;
            let mut rows = q.query_map([room_id], message_from_row)?;
            let mut turns: Vec<String> = Vec::new();
            let mut out = Vec::new();
            // Stream newest-first and stop once the window is full.
            for message in rows.by_ref() {
                let message = message?;
                if !turns.contains(&message.turn_id) {
                    if turns.len() >= turn_limit {
                        break;
                    }
                    turns.push(message.turn_id.clone());
                }
                out.push(message);
            }
            out.reverse();
            Ok(out)
        })
    }
    /// Apply incremental turn writes in one transaction.
    pub fn append_turns(&self, caller: &Caller, appends: Vec<TurnAppend>) -> Result<()> {
        for append in &appends {
            if !caller.trusted && append.room_id != caller.room_id {
                bail!("cannot append a turn outside the caller's room");
            }
            if append.turn_id.is_empty() || append.room_id.is_empty() {
                bail!("archive turn requires id and room");
            }
            if append
                .participants
                .iter()
                .any(|p| p.participant_id.trim().is_empty())
            {
                bail!("archive participants require an id");
            }
            for message in &append.messages {
                if message.id.is_empty()
                    || message.speaker.trim().is_empty()
                    || message.content.trim().is_empty()
                {
                    bail!("archive messages require id, speaker, and content");
                }
            }
        }
        self.store.append_turns(&appends)
    }
    /// Every turn and message archived for `room_id`, oldest first.
    pub fn room_archive(&self, caller: &Caller, room_id: &str) -> Result<RoomArchive> {
        if !caller.trusted && room_id != caller.room_id {
            bail!("cannot read another room archive");
        }
        self.store.room_archive(room_id)
    }
}
