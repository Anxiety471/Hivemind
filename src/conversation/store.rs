use super::*;

pub(super) static ROOM_LOCKS: OnceCell<Mutex<HashMap<String, Weak<Mutex<()>>>>> =
    OnceCell::const_new();

/// Create the store directory and resolve it once; room lock keys use the result.
pub(super) fn canonical_store_dir(directory: &Path) -> Result<PathBuf> {
    fs::create_dir_all(directory)
        .with_context(|| format!("creating context store {}", directory.display()))?;
    fs::canonicalize(directory)
        .with_context(|| format!("resolving context store {}", directory.display()))
}

/// `directory` must already be canonical (see [`canonical_store_dir`]).
pub(super) async fn room_mutex(directory: &Path, room: &str) -> Result<Arc<Mutex<()>>> {
    let key = format!("{}\0{room}", directory.display());
    let locks = ROOM_LOCKS
        .get_or_init(|| async { Mutex::new(HashMap::new()) })
        .await;
    let mut locks = locks.lock().await;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    Ok(lock)
}

pub(super) struct TurnFileLock {
    _file: fs::File,
}

pub(super) fn stable_hash(value: &str) -> u64 {
    value
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        })
}

/// Deterministic, room-scoped id for a legacy archived turn so a retried
/// import re-upserts the same row instead of creating a second one.
pub(super) fn legacy_turn_id(room: &str, old_turn_id: &str) -> String {
    format!("legacy-turn-{:016x}-{old_turn_id}", stable_hash(room))
}

/// Deterministic, room-scoped id for a legacy archived message. The numeric
/// prefix derives only from the room and the event's position in the legacy
/// file (2020 epoch + room salt + 1 ms per event), so file order is
/// preserved, real 2026 events always sort after migrated ones, and every
/// retry produces byte-identical ids.
pub(super) fn legacy_message_id(room: &str, index: usize, old_id: &str) -> String {
    const LEGACY_BASE_NANOS: u64 = 1_600_000_000_000_000_000;
    let room_salt = stable_hash(room) % 10_000_000_000;
    let nanos = LEGACY_BASE_NANOS + room_salt + index as u64 * 1_000_000;
    format!("{nanos:020}-legacy-{:016x}-{old_id}", stable_hash(room))
}

pub(super) async fn acquire_file_lock(directory: &Path, room: &str) -> Result<TurnFileLock> {
    let path = directory.join(format!(".room-{:016x}.lock", stable_hash(room)));
    let open = || {
        fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
    };
    let file = match open() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(directory)
                .with_context(|| format!("creating context store {}", directory.display()))?;
            open()
        }
        other => other,
    }
    .with_context(|| {
        format!(
            "opening room lock for '{room}' in context store {}",
            directory.display()
        )
    })?;
    // Block a pool thread, not an async worker, until the lock is free.
    tokio::task::spawn_blocking(move || file.lock().map(|()| file))
        .await
        .context("room lock task failed")?
        .map(|file| TurnFileLock { _file: file })
        .with_context(|| {
            format!(
                "locking room '{room}' in context store {}",
                directory.display()
            )
        })
}

/// What a save must persist beyond a full rewrite. Stores without an
/// incremental path fall back to [`ContextStore::save_room`].
pub struct Changes<'a> {
    /// New events of the active turn and/or its completion.
    pub turn: Option<TurnChange<'a>>,
    /// Rewrite the room-level state snapshot (state, summary, maintenance log).
    pub snapshot: bool,
}

pub struct TurnChange<'a> {
    pub turn_id: &'a str,
    /// Index in `RoomHistory::events` of the first event not yet persisted.
    pub events_from: usize,
    pub completed: bool,
}

pub trait ContextStore: Send + Sync {
    fn directory(&self) -> &std::path::Path;
    fn load_room(&self, room: &str) -> Result<RoomHistory>;
    fn save_room(&self, room: &str, history: &RoomHistory) -> Result<()>;
    /// Take a room's history for one turn. The caller owns it until
    /// [`Self::release`]; a store may hand back a cached copy.
    fn checkout(&self, room: &str) -> Result<RoomHistory> {
        self.load_room(room)
    }
    /// Return a history that was fully persisted through [`Self::save_changes`].
    fn release(&self, _room: &str, _history: RoomHistory) {}
    fn save_changes(
        &self,
        room: &str,
        history: &RoomHistory,
        _changes: &Changes<'_>,
    ) -> Result<()> {
        self.save_room(room, history)
    }
}

pub struct JsonFileStore {
    directory: PathBuf,
}
impl JsonFileStore {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
        }
    }
    pub(super) fn room_path(&self, room: &str) -> PathBuf {
        let hash = stable_hash(room);
        let safe: String = room
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .take(40)
            .collect();
        self.directory.join(format!("{safe}-{hash:016x}.json"))
    }
}
impl ContextStore for JsonFileStore {
    fn directory(&self) -> &std::path::Path {
        &self.directory
    }
    fn load_room(&self, room: &str) -> Result<RoomHistory> {
        let path = self.room_path(room);
        if !path.exists() {
            return Ok(RoomHistory {
                room_id: room.to_owned(),
                ..RoomHistory::default()
            });
        }
        let mut history: RoomHistory = serde_json::from_slice(
            &fs::read(&path).with_context(|| format!("reading room history {}", path.display()))?,
        )
        .context("decoding canonical room history")?;
        if !history.room_id.is_empty() && history.room_id != room {
            bail!("room history identifier mismatch");
        }
        history.room_id = room.to_owned();
        for event in &mut history.events {
            if event.speaker != "user" && event.agent_instance_id.is_none() {
                event.agent_instance_id =
                    Some(crate::identity::AgentInstanceId::new(room, &event.speaker));
            }
        }
        Ok(history)
    }
    fn save_room(&self, room: &str, history: &RoomHistory) -> Result<()> {
        if history.room_id != room {
            bail!("cannot save room history under a different room identifier");
        }
        fs::create_dir_all(&self.directory)
            .with_context(|| format!("creating context store {}", self.directory.display()))?;
        let path = self.room_path(room);
        let temp = path.with_extension(format!("{}.tmp", stable_id()));
        fs::write(&temp, serde_json::to_vec(history)?)
            .with_context(|| format!("writing {}", temp.display()))?;
        fs::rename(&temp, &path).with_context(|| format!("replacing {}", path.display()))
    }
}

/// Room-level working state persisted alongside the L7 archive in one
/// reserved archive turn per room; there is no second (JSON) history file.
/// Per-turn facts (completion, failed replies, legacy identities) live on the
/// turn rows themselves, so this row stays O(1) regardless of history length.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub(super) struct RoomSnapshot {
    #[serde(default)]
    state: RoomState,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    summarized_turn_count: usize,
    #[serde(default)]
    maintenance_errors: Vec<String>,
    /// Read-only: lists written by earlier versions, moved onto the turn rows
    /// the first time such a snapshot is loaded.
    #[serde(default, skip_serializing)]
    completed_turns: Vec<String>,
    #[serde(default, skip_serializing)]
    error_message_ids: Vec<String>,
    #[serde(default, skip_serializing)]
    legacy_agent_instance_ids: HashMap<String, String>,
}

impl RoomSnapshot {
    fn has_pre_turn_metadata_lists(&self) -> bool {
        !self.completed_turns.is_empty()
            || !self.error_message_ids.is_empty()
            || !self.legacy_agent_instance_ids.is_empty()
    }
}

pub(super) fn room_state_turn_id(room: &str) -> String {
    format!("room-state:{room}")
}

/// The store acts for Hivemind itself when mirroring history into the
/// archive; model-facing calls always use per-invocation callers instead.
pub(super) fn archive_caller() -> Caller {
    Caller::trusted_user("hivemind-store")
}

pub(super) fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// Failed-reply ids and legacy identities of one turn, as stored in the turn
/// row's metadata (`null` when there is nothing to record).
fn encode_turn_flags(errors: &[String], legacy: &BTreeMap<String, String>) -> serde_json::Value {
    if errors.is_empty() && legacy.is_empty() {
        return serde_json::Value::Null;
    }
    serde_json::json!({ "errors": errors, "legacy_agent_instance_ids": legacy })
}

fn decode_turn_flags(metadata: &serde_json::Value) -> (Vec<String>, BTreeMap<String, String>) {
    let errors = metadata
        .get("errors")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default();
    let legacy = metadata
        .get("legacy_agent_instance_ids")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default();
    (errors, legacy)
}

fn turn_flags_from_events(events: &[&MessageEvent]) -> serde_json::Value {
    let errors: Vec<String> = events
        .iter()
        .filter(|event| event.error)
        .map(|event| event.id.clone())
        .collect();
    let legacy: BTreeMap<String, String> = events
        .iter()
        .filter_map(|event| {
            event
                .legacy_agent_instance_id
                .as_ref()
                .map(|legacy_id| (event.id.clone(), legacy_id.clone()))
        })
        .collect();
    encode_turn_flags(&errors, &legacy)
}

/// Groups events by turn id, preserving first-seen turn order.
pub(super) fn events_by_turn(
    events: &[MessageEvent],
) -> (Vec<String>, HashMap<String, Vec<&MessageEvent>>) {
    let mut order = Vec::new();
    let mut grouped: HashMap<String, Vec<&MessageEvent>> = HashMap::new();
    for event in events {
        if !grouped.contains_key(&event.turn_id) {
            order.push(event.turn_id.clone());
            grouped.insert(event.turn_id.clone(), Vec::new());
        }
        grouped
            .get_mut(&event.turn_id)
            .expect("group inserted above")
            .push(event);
    }
    (order, grouped)
}

pub(super) fn turn_participants(events: &[&MessageEvent]) -> Vec<ArchiveParticipant> {
    let mut seen = HashSet::new();
    events
        .iter()
        .filter(|event| event.speaker != "user")
        .filter(|event| seen.insert(event.speaker.as_str()))
        .map(|event| ArchiveParticipant {
            participant_id: event.speaker.clone(),
            role: None,
        })
        .collect()
}

pub(super) fn turn_messages(
    room: &str,
    turn_id: &str,
    events: &[&MessageEvent],
) -> Vec<ArchivedMessage> {
    events
        .iter()
        .filter(|event| !event.content.trim().is_empty())
        .map(|event| ArchivedMessage {
            id: event.id.clone(),
            room_id: room.to_owned(),
            turn_id: turn_id.to_owned(),
            speaker: event.speaker.clone(),
            content: event.content.clone(),
            created_at: id_timestamp(&event.id),
        })
        .collect()
}

/// Rooms whose parsed history is kept between turns.
const CACHED_ROOMS: usize = 32;

struct CachedRoom {
    history: RoomHistory,
    data_version: i64,
    used: u64,
}

/// Canonical room history backed by the L7 SQLite archive. Legacy JSON room
/// files are imported exactly once (id remapping preserves order), then
/// removed so JSON never remains a second source of truth.
///
/// A turn persists only what it changes (the active turn's new messages, its
/// completion, and the small state snapshot). The parsed history of recently
/// used rooms is cached between turns and trusted only while SQLite's
/// `data_version` shows no other connection or process has written since.
pub struct SqliteContextStore {
    directory: PathBuf,
    memory: Arc<MemoryService>,
    cache: parking_lot::Mutex<HashMap<String, CachedRoom>>,
    clock: std::sync::atomic::AtomicU64,
}

impl SqliteContextStore {
    pub fn new(directory: impl Into<PathBuf>, memory: Arc<MemoryService>) -> Self {
        Self {
            directory: directory.into(),
            memory,
            cache: parking_lot::Mutex::new(HashMap::new()),
            clock: std::sync::atomic::AtomicU64::new(0),
        }
    }

    fn import_legacy(&self, room: &str, legacy: &RoomHistory) -> Result<()> {
        let caller = archive_caller();
        // Deterministic, room-scoped ids: retrying a partial import rewrites
        // exactly the same archived rows instead of duplicating them, and the
        // 2020-epoch numeric prefix keeps migrated events ordered before any
        // event created by live turns.
        let remapped_events: Vec<MessageEvent> = legacy
            .events
            .iter()
            .enumerate()
            .map(|(index, event)| {
                let mut event = event.clone();
                event.id = legacy_message_id(room, index, &event.id);
                event.turn_id = legacy_turn_id(room, &event.turn_id);
                event
            })
            .collect();
        let completed: HashSet<String> = legacy
            .completed_turns
            .iter()
            .map(|turn| legacy_turn_id(room, turn))
            .collect();
        let (order, grouped) = events_by_turn(&remapped_events);
        for turn_id in &order {
            let events = grouped
                .get(turn_id)
                .context("grouped legacy turn disappeared")?;
            let messages = turn_messages(room, turn_id, events);
            let started_at = messages
                .first()
                .map(|message| message.created_at)
                .unwrap_or_else(|| id_timestamp(turn_id));
            self.memory.append_archive_turn(
                &caller,
                ArchivedTurn {
                    id: turn_id.clone(),
                    room_id: room.to_owned(),
                    started_at,
                    completed_at: if completed.contains(turn_id.as_str()) {
                        Some(now_secs())
                    } else {
                        None
                    },
                    metadata: turn_flags_from_events(events),
                    participants: turn_participants(events),
                    messages,
                },
            )?;
        }
        // Merge with any snapshot a previous partial attempt wrote: legacy
        // fills an empty baseline wholesale; otherwise newer fields win and
        // the maintenance log is unioned (legacy history is older).
        let existing = self
            .memory
            .archive_turn(&caller, room, &room_state_turn_id(room))?
            .map(|turn| serde_json::from_value::<RoomSnapshot>(turn.metadata))
            .transpose()
            .context("decoding existing snapshot during legacy import")?
            .unwrap_or_default();
        let snapshot = if existing == RoomSnapshot::default() {
            RoomSnapshot {
                state: legacy.state.clone(),
                summary: legacy.summary.clone(),
                summarized_turn_count: legacy.summarized_turn_count,
                maintenance_errors: legacy.maintenance_errors.clone(),
                ..RoomSnapshot::default()
            }
        } else {
            let mut maintenance_errors = legacy.maintenance_errors.clone();
            for entry in &existing.maintenance_errors {
                if !maintenance_errors.contains(entry) {
                    maintenance_errors.push(entry.clone());
                }
            }
            RoomSnapshot {
                state: existing.state,
                summary: existing.summary,
                summarized_turn_count: existing.summarized_turn_count,
                maintenance_errors,
                ..RoomSnapshot::default()
            }
        };
        self.write_snapshot(room, &snapshot)
    }

    fn write_snapshot(&self, room: &str, snapshot: &RoomSnapshot) -> Result<()> {
        self.memory.append_archive_turn(
            &archive_caller(),
            ArchivedTurn {
                id: room_state_turn_id(room),
                room_id: room.to_owned(),
                started_at: now_secs(),
                completed_at: None,
                metadata: serde_json::to_value(snapshot)?,
                participants: Vec::new(),
                messages: Vec::new(),
            },
        )
    }

    /// Read a room's complete history from SQLite, importing a legacy JSON
    /// file and upgrading a pre-turn-metadata snapshot first when present.
    fn load_from_database(&self, room: &str) -> Result<RoomHistory> {
        let legacy_store = JsonFileStore::new(&self.directory);
        let legacy_path = legacy_store.room_path(room);
        if legacy_path.exists() {
            let legacy = legacy_store.load_room(room)?;
            // Always re-import the complete file: stable room-scoped ids make
            // per-turn upserts idempotent, so a crashed partial attempt is
            // finished here rather than inferred from existing archive rows.
            self.import_legacy(room, &legacy)?;
            fs::remove_file(&legacy_path).with_context(|| {
                format!("removing migrated legacy history {}", legacy_path.display())
            })?;
        }
        let caller = archive_caller();
        let archive = self.memory.room_archive(&caller, room)?;
        let state_id = room_state_turn_id(room);
        let snapshot = archive
            .turns
            .iter()
            .find(|turn| turn.id == state_id)
            .map(|turn| serde_json::from_value::<RoomSnapshot>(turn.metadata.clone()))
            .transpose()
            .context("decoding room snapshot")?
            .unwrap_or_default();

        let mut errors: HashSet<String> = snapshot.error_message_ids.iter().cloned().collect();
        let mut legacy_ids: HashMap<String, String> = snapshot.legacy_agent_instance_ids.clone();
        for turn in archive.turns.iter().filter(|turn| turn.id != state_id) {
            let (turn_errors, turn_legacy) = decode_turn_flags(&turn.metadata);
            errors.extend(turn_errors);
            legacy_ids.extend(turn_legacy);
        }
        if snapshot.has_pre_turn_metadata_lists() {
            self.upgrade_snapshot(room, &archive, &snapshot)?;
        }

        let events = archive
            .messages
            .into_iter()
            .map(|message| MessageEvent {
                agent_instance_id: if message.speaker == "user" {
                    None
                } else {
                    Some(crate::identity::AgentInstanceId::new(
                        room,
                        &message.speaker,
                    ))
                },
                legacy_agent_instance_id: legacy_ids.get(&message.id).cloned(),
                error: errors.contains(&message.id),
                id: message.id,
                turn_id: message.turn_id,
                speaker: message.speaker,
                content: message.content,
            })
            .collect();
        Ok(RoomHistory {
            room_id: room.to_owned(),
            events,
            state: snapshot.state,
            summary: snapshot.summary,
            completed_turns: archive
                .turns
                .iter()
                .filter(|turn| turn.id != state_id && turn.completed_at.is_some())
                .map(|turn| turn.id.clone())
                .collect(),
            summarized_turn_count: snapshot.summarized_turn_count,
            maintenance_errors: snapshot.maintenance_errors,
        })
    }

    /// Move the per-history lists of an older snapshot onto their turn rows
    /// and rewrite the snapshot without them, so it is small from now on.
    fn upgrade_snapshot(
        &self,
        room: &str,
        archive: &RoomArchive,
        snapshot: &RoomSnapshot,
    ) -> Result<()> {
        let turn_of: HashMap<&str, &str> = archive
            .messages
            .iter()
            .map(|message| (message.id.as_str(), message.turn_id.as_str()))
            .collect();
        let mut errors: HashMap<&str, Vec<String>> = HashMap::new();
        for id in &snapshot.error_message_ids {
            if let Some(turn) = turn_of.get(id.as_str()) {
                errors.entry(turn).or_default().push(id.clone());
            }
        }
        let mut legacy: HashMap<&str, BTreeMap<String, String>> = HashMap::new();
        for (id, legacy_id) in &snapshot.legacy_agent_instance_ids {
            if let Some(turn) = turn_of.get(id.as_str()) {
                legacy
                    .entry(turn)
                    .or_default()
                    .insert(id.clone(), legacy_id.clone());
            }
        }
        let mut appends = Vec::new();
        for turn in errors.keys().chain(legacy.keys()).collect::<HashSet<_>>() {
            let existing = archive
                .turns
                .iter()
                .find(|candidate| candidate.id == **turn);
            let (mut turn_errors, mut turn_legacy) = existing
                .map(|existing| decode_turn_flags(&existing.metadata))
                .unwrap_or_default();
            for id in errors.get(*turn).into_iter().flatten() {
                if !turn_errors.contains(id) {
                    turn_errors.push(id.clone());
                }
            }
            turn_legacy.extend(legacy.get(*turn).cloned().unwrap_or_default());
            appends.push(TurnAppend {
                room_id: room.to_owned(),
                turn_id: (*turn).to_owned(),
                started_at: now_secs(),
                completed_at: None,
                metadata: encode_turn_flags(&turn_errors, &turn_legacy),
                participants: Vec::new(),
                messages: Vec::new(),
                state_turn: None,
            });
        }
        if !appends.is_empty() {
            self.memory.append_turns(&archive_caller(), appends)?;
        }
        self.write_snapshot(room, snapshot)
    }
}

impl ContextStore for SqliteContextStore {
    fn directory(&self) -> &std::path::Path {
        &self.directory
    }

    fn load_room(&self, room: &str) -> Result<RoomHistory> {
        self.load_from_database(room)
    }

    fn checkout(&self, room: &str) -> Result<RoomHistory> {
        let version = self.memory.store().data_version()?;
        if let Some(entry) = self.cache.lock().remove(room) {
            if entry.data_version == version {
                return Ok(entry.history);
            }
        }
        self.load_from_database(room)
    }

    fn release(&self, room: &str, mut history: RoomHistory) {
        // A reload never contains contentless events (they are not archived);
        // drop them so a cached history is identical to a fresh one.
        history
            .events
            .retain(|event| !event.content.trim().is_empty());
        let Ok(data_version) = self.memory.store().data_version() else {
            return;
        };
        let used = self
            .clock
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut cache = self.cache.lock();
        if cache.len() >= CACHED_ROOMS && !cache.contains_key(room) {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, entry)| entry.used)
                .map(|(key, _)| key.clone())
            {
                cache.remove(&oldest);
            }
        }
        cache.insert(
            room.to_owned(),
            CachedRoom {
                history,
                data_version,
                used,
            },
        );
    }

    fn save_changes(&self, room: &str, history: &RoomHistory, changes: &Changes<'_>) -> Result<()> {
        if history.room_id != room {
            bail!("cannot save room history under a different room identifier");
        }
        let snapshot = changes
            .snapshot
            .then(|| serde_json::to_value(snapshot_from_history(history)))
            .transpose()?;
        let Some(change) = &changes.turn else {
            if let Some(snapshot) = snapshot {
                self.memory.append_archive_turn(
                    &archive_caller(),
                    ArchivedTurn {
                        id: room_state_turn_id(room),
                        room_id: room.to_owned(),
                        started_at: now_secs(),
                        completed_at: None,
                        metadata: snapshot,
                        participants: Vec::new(),
                        messages: Vec::new(),
                    },
                )?;
            }
            return Ok(());
        };
        let tail_start = history
            .events
            .iter()
            .rposition(|event| event.turn_id != change.turn_id)
            .map_or(0, |index| index + 1);
        let turn_events: Vec<&MessageEvent> = history.events[tail_start..].iter().collect();
        let first_new = change.events_from.max(tail_start) - tail_start;
        let new_events = &turn_events[first_new.min(turn_events.len())..];
        let started_at = turn_events
            .first()
            .map(|event| id_timestamp(&event.id))
            .unwrap_or_else(|| id_timestamp(change.turn_id));
        self.memory.append_turns(
            &archive_caller(),
            vec![TurnAppend {
                room_id: room.to_owned(),
                turn_id: change.turn_id.to_owned(),
                started_at,
                completed_at: change.completed.then(now_secs),
                metadata: turn_flags_from_events(&turn_events),
                participants: turn_participants(new_events),
                messages: turn_messages(room, change.turn_id, new_events),
                state_turn: snapshot.map(|snapshot| (room_state_turn_id(room), snapshot)),
            }],
        )
    }

    fn save_room(&self, room: &str, history: &RoomHistory) -> Result<()> {
        if history.room_id != room {
            bail!("cannot save room history under a different room identifier");
        }
        let completed: HashSet<&str> = history.completed_turns.iter().map(String::as_str).collect();
        let (order, grouped) = events_by_turn(&history.events);
        for turn_id in &order {
            let events = grouped.get(turn_id).context("grouped turn disappeared")?;
            let messages = turn_messages(room, turn_id, events);
            let started_at = messages
                .first()
                .map(|message| message.created_at)
                .unwrap_or_else(|| id_timestamp(turn_id));
            self.memory.append_archive_turn(
                &archive_caller(),
                ArchivedTurn {
                    id: turn_id.clone(),
                    room_id: room.to_owned(),
                    started_at,
                    completed_at: if completed.contains(turn_id.as_str()) {
                        Some(now_secs())
                    } else {
                        None
                    },
                    metadata: turn_flags_from_events(events),
                    participants: turn_participants(events),
                    messages,
                },
            )?;
        }
        self.write_snapshot(room, &snapshot_from_history(history))
    }
}

pub(super) fn snapshot_from_history(history: &RoomHistory) -> RoomSnapshot {
    RoomSnapshot {
        state: history.state.clone(),
        summary: history.summary.clone(),
        summarized_turn_count: history.summarized_turn_count,
        maintenance_errors: history.maintenance_errors.clone(),
        ..RoomSnapshot::default()
    }
}
