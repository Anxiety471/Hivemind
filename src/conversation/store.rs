use super::*;

pub(super) static ROOM_LOCKS: OnceCell<Mutex<HashMap<String, Weak<Mutex<()>>>>> =
    OnceCell::const_new();

pub(super) async fn room_mutex(directory: &Path, room: &str) -> Result<Arc<Mutex<()>>> {
    fs::create_dir_all(directory)
        .with_context(|| format!("creating context store {}", directory.display()))?;
    let directory = fs::canonicalize(directory)
        .with_context(|| format!("resolving context store {}", directory.display()))?;
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
    fs::create_dir_all(directory)
        .with_context(|| format!("creating context store {}", directory.display()))?;
    let path = directory.join(format!(".room-{:016x}.lock", stable_hash(room)));
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .with_context(|| {
            format!(
                "opening room lock for '{room}' in context store {}",
                directory.display()
            )
        })?;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(TurnFileLock { _file: file }),
            Err(std::fs::TryLockError::WouldBlock) => {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            Err(std::fs::TryLockError::Error(error)) => {
                return Err(error).with_context(|| {
                    format!(
                        "locking room '{room}' in context store {}",
                        directory.display()
                    )
                });
            }
        }
    }
}

pub trait ContextStore: Send + Sync {
    fn directory(&self) -> &std::path::Path;
    fn load_room(&self, room: &str) -> Result<RoomHistory>;
    fn save_room(&self, room: &str, history: &RoomHistory) -> Result<()>;
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
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub(super) struct RoomSnapshot {
    #[serde(default)]
    state: RoomState,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    summarized_turn_count: usize,
    #[serde(default)]
    completed_turns: Vec<String>,
    #[serde(default)]
    error_message_ids: Vec<String>,
    #[serde(default)]
    maintenance_errors: Vec<String>,
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

pub(super) fn turn_fingerprint<'a>(
    events: impl IntoIterator<Item = &'a MessageEvent>,
    completed: bool,
) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for event in events {
        event.id.hash(&mut hasher);
        event.turn_id.hash(&mut hasher);
        event.speaker.hash(&mut hasher);
        event.agent_instance_id.hash(&mut hasher);
        event.content.hash(&mut hasher);
        event.error.hash(&mut hasher);
    }
    completed.hash(&mut hasher);
    hasher.finish()
}

pub(super) fn snapshot_fingerprint(snapshot: &RoomSnapshot) -> Result<u64> {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_vec(snapshot)?.hash(&mut hasher);
    Ok(hasher.finish())
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

/// Canonical room history backed by the L7 SQLite archive. Legacy JSON room
/// files are imported exactly once (id remapping preserves order), then
/// removed so JSON never remains a second source of truth.
pub struct SqliteContextStore {
    directory: PathBuf,
    memory: Arc<MemoryService>,
    turn_fingerprints: std::sync::Mutex<HashMap<(String, String), u64>>,
    snapshot_fingerprints: std::sync::Mutex<HashMap<String, u64>>,
}

impl SqliteContextStore {
    pub fn new(directory: impl Into<PathBuf>, memory: Arc<MemoryService>) -> Self {
        Self {
            directory: directory.into(),
            memory,
            turn_fingerprints: std::sync::Mutex::new(HashMap::new()),
            snapshot_fingerprints: std::sync::Mutex::new(HashMap::new()),
        }
    }

    fn lock_cache<'a, T>(
        cache: &'a std::sync::Mutex<T>,
        what: &str,
    ) -> Result<std::sync::MutexGuard<'a, T>> {
        cache
            .lock()
            .map_err(|_| anyhow::anyhow!("{what} cache lock poisoned"))
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
                    metadata: serde_json::Value::Null,
                    participants: turn_participants(events),
                    messages,
                },
            )?;
        }
        // Merge with any snapshot a previous partial attempt wrote: legacy
        // fills an empty baseline wholesale; otherwise newer fields win and
        // the turn/error lists are unioned (legacy history is older).
        let existing = self
            .memory
            .archive_turn(&caller, room, &room_state_turn_id(room))?
            .map(|turn| serde_json::from_value::<RoomSnapshot>(turn.metadata))
            .transpose()
            .context("decoding existing snapshot during legacy import")?
            .unwrap_or_default();
        let legacy_completed: Vec<String> = legacy
            .completed_turns
            .iter()
            .map(|turn| legacy_turn_id(room, turn))
            .collect();
        let legacy_errors: Vec<String> = remapped_events
            .iter()
            .filter(|event| event.error)
            .map(|event| event.id.clone())
            .collect();
        let snapshot = if existing == RoomSnapshot::default() {
            RoomSnapshot {
                state: legacy.state.clone(),
                summary: legacy.summary.clone(),
                summarized_turn_count: legacy.summarized_turn_count,
                completed_turns: legacy_completed,
                error_message_ids: legacy_errors,
                maintenance_errors: legacy.maintenance_errors.clone(),
            }
        } else {
            let mut completed_turns = legacy_completed;
            for turn in &existing.completed_turns {
                if !completed_turns.contains(turn) {
                    completed_turns.push(turn.clone());
                }
            }
            let mut error_message_ids = legacy_errors;
            for id in &existing.error_message_ids {
                if !error_message_ids.contains(id) {
                    error_message_ids.push(id.clone());
                }
            }
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
                completed_turns,
                error_message_ids,
                maintenance_errors,
            }
        };
        self.write_snapshot(room, &snapshot)
    }

    fn write_snapshot(&self, room: &str, snapshot: &RoomSnapshot) -> Result<()> {
        let fingerprint = snapshot_fingerprint(snapshot)?;
        if Self::lock_cache(&self.snapshot_fingerprints, "snapshot")?
            .get(room)
            .is_some_and(|known| *known == fingerprint)
        {
            return Ok(());
        }
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
        )?;
        Self::lock_cache(&self.snapshot_fingerprints, "snapshot")?
            .insert(room.to_owned(), fingerprint);
        Ok(())
    }

    fn prime_caches(&self, history: &RoomHistory) -> Result<()> {
        let completed: HashSet<&str> = history.completed_turns.iter().map(String::as_str).collect();
        let (order, grouped) = events_by_turn(&history.events);
        let mut turn_cache = Self::lock_cache(&self.turn_fingerprints, "turn")?;
        for turn_id in &order {
            let events = grouped.get(turn_id).context("grouped turn disappeared")?;
            turn_cache.insert(
                (history.room_id.clone(), turn_id.clone()),
                turn_fingerprint(events.iter().copied(), completed.contains(turn_id.as_str())),
            );
        }
        drop(turn_cache);
        let snapshot = snapshot_from_history(history)?;
        Self::lock_cache(&self.snapshot_fingerprints, "snapshot")?
            .insert(history.room_id.clone(), snapshot_fingerprint(&snapshot)?);
        Ok(())
    }
}

pub(super) fn snapshot_from_history(history: &RoomHistory) -> Result<RoomSnapshot> {
    Ok(RoomSnapshot {
        state: history.state.clone(),
        summary: history.summary.clone(),
        summarized_turn_count: history.summarized_turn_count,
        completed_turns: history.completed_turns.clone(),
        error_message_ids: history
            .events
            .iter()
            .filter(|event| event.error)
            .map(|event| event.id.clone())
            .collect(),
        maintenance_errors: history.maintenance_errors.clone(),
    })
}

impl ContextStore for SqliteContextStore {
    fn directory(&self) -> &std::path::Path {
        &self.directory
    }

    fn load_room(&self, room: &str) -> Result<RoomHistory> {
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
        let snapshot = self
            .memory
            .archive_turn(&archive_caller(), room, &room_state_turn_id(room))?
            .map(|turn| serde_json::from_value::<RoomSnapshot>(turn.metadata))
            .transpose()
            .context("decoding room snapshot")?
            .unwrap_or_default();
        let error_ids: HashSet<&str> = snapshot
            .error_message_ids
            .iter()
            .map(String::as_str)
            .collect();
        let events = self
            .memory
            .recent_messages(&archive_caller(), room, usize::MAX)?
            .into_iter()
            .map(|message| MessageEvent {
                id: message.id.clone(),
                turn_id: message.turn_id,
                speaker: message.speaker.clone(),
                agent_instance_id: if message.speaker == "user" {
                    None
                } else {
                    Some(format!("{room}/{}", message.speaker))
                },
                content: message.content,
                error: error_ids.contains(message.id.as_str()),
            })
            .collect();
        let history = RoomHistory {
            room_id: room.to_owned(),
            events,
            state: snapshot.state,
            summary: snapshot.summary,
            completed_turns: snapshot.completed_turns,
            summarized_turn_count: snapshot.summarized_turn_count,
            maintenance_errors: snapshot.maintenance_errors,
        };
        self.prime_caches(&history)?;
        Ok(history)
    }

    fn save_room(&self, room: &str, history: &RoomHistory) -> Result<()> {
        if history.room_id != room {
            bail!("cannot save room history under a different room identifier");
        }
        let completed: HashSet<&str> = history.completed_turns.iter().map(String::as_str).collect();
        let (order, grouped) = events_by_turn(&history.events);
        {
            let mut cache = Self::lock_cache(&self.turn_fingerprints, "turn")?;
            for turn_id in &order {
                let events = grouped.get(turn_id).context("grouped turn disappeared")?;
                let is_completed = completed.contains(turn_id.as_str());
                let fingerprint = turn_fingerprint(events.iter().copied(), is_completed);
                if cache
                    .get(&(room.to_owned(), turn_id.clone()))
                    .is_some_and(|known| *known == fingerprint)
                {
                    continue;
                }
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
                        completed_at: if is_completed { Some(now_secs()) } else { None },
                        metadata: serde_json::Value::Null,
                        participants: turn_participants(events),
                        messages,
                    },
                )?;
                cache.insert((room.to_owned(), turn_id.clone()), fingerprint);
            }
        }
        self.write_snapshot(room, &snapshot_from_history(history)?)
    }
}
