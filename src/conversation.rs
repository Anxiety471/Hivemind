use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Weak},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::memory::{
    ArchiveParticipant, ArchivedMessage, ArchivedTurn, Caller, Layer, MemoryService, MemoryStatus,
    MemoryWrite, Provenance, Scope, SearchRequest, SearchScope,
};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::{
    sync::{Mutex, OnceCell},
    task::JoinSet,
};

use crate::config::{AgentConfig, ContextConfig, ConversationMode};
use crate::runtime::{
    InvokeReply, InvokeRequest, PromptDelta, PromptPhase, RuntimePool, SessionCursor, TurnView,
};

static ROOM_LOCKS: OnceCell<Mutex<HashMap<String, Weak<Mutex<()>>>>> = OnceCell::const_new();

async fn room_mutex(directory: &Path, room: &str) -> Result<Arc<Mutex<()>>> {
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

struct TurnFileLock {
    _file: fs::File,
}

fn stable_hash(value: &str) -> u64 {
    value
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        })
}

/// Deterministic, room-scoped id for a legacy archived turn so a retried
/// import re-upserts the same row instead of creating a second one.
fn legacy_turn_id(room: &str, old_turn_id: &str) -> String {
    format!("legacy-turn-{:016x}-{old_turn_id}", stable_hash(room))
}

/// Deterministic, room-scoped id for a legacy archived message. The numeric
/// prefix derives only from the room and the event's position in the legacy
/// file (2020 epoch + room salt + 1 ms per event), so file order is
/// preserved, real 2026 events always sort after migrated ones, and every
/// retry produces byte-identical ids.
fn legacy_message_id(room: &str, index: usize, old_id: &str) -> String {
    const LEGACY_BASE_NANOS: u64 = 1_600_000_000_000_000_000;
    let room_salt = stable_hash(room) % 10_000_000_000;
    let nanos = LEGACY_BASE_NANOS + room_salt + index as u64 * 1_000_000;
    format!("{nanos:020}-legacy-{:016x}-{old_id}", stable_hash(room))
}

async fn acquire_file_lock(directory: &Path, room: &str) -> Result<TurnFileLock> {
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

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct RoomState {
    pub goal: Option<String>,
    pub decisions: Vec<String>,
    pub assignments: BTreeMap<String, String>,
    pub open_questions: Vec<String>,
    pub completed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageEvent {
    pub id: String,
    pub turn_id: String,
    pub speaker: String,
    #[serde(default)]
    pub agent_instance_id: Option<String>,
    pub content: String,
    pub error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RoomHistory {
    #[serde(default)]
    pub room_id: String,
    #[serde(default)]
    pub events: Vec<MessageEvent>,
    #[serde(default)]
    pub state: RoomState,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub completed_turns: Vec<String>,
    #[serde(default)]
    pub summarized_turn_count: usize,
    #[serde(default)]
    pub maintenance_errors: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Participant {
    pub agent: AgentConfig,
    pub role: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TurnReply {
    pub name: String,
    pub result: Result<String, String>,
}

#[async_trait]
pub trait AgentInvoker: Send + Sync {
    /// Live continuable session state for this instance; None means the next prompt hydrates.
    async fn cursor(&self, instance_id: &str) -> Option<SessionCursor>;
    async fn invoke(&self, request: InvokeRequest<'_>) -> Result<InvokeReply>;
}

/// Routes a turn's invocations to the core-owned per-instance runtime pool.
pub struct RuntimeInvoker {
    pool: Arc<RuntimePool>,
    room_id: String,
    group_id: String,
}

impl RuntimeInvoker {
    pub fn new(pool: Arc<RuntimePool>, room_id: &str, group_id: &str) -> Self {
        Self {
            pool,
            room_id: room_id.to_owned(),
            group_id: group_id.to_owned(),
        }
    }
}

#[async_trait]
impl AgentInvoker for RuntimeInvoker {
    async fn cursor(&self, instance_id: &str) -> Option<SessionCursor> {
        self.pool.cursor(instance_id).await
    }

    async fn invoke(&self, request: InvokeRequest<'_>) -> Result<InvokeReply> {
        let caller = Caller::agent(
            self.room_id.clone(),
            self.group_id.clone(),
            request.instance_id,
            &request.agent.name,
            &request.agent.name,
        );
        self.pool.invoke(&caller, request).await
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
    fn room_path(&self, room: &str) -> PathBuf {
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
struct RoomSnapshot {
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

fn room_state_turn_id(room: &str) -> String {
    format!("room-state:{room}")
}

/// The store acts for Hivemind itself when mirroring history into the
/// archive; model-facing calls always use per-invocation callers instead.
fn archive_caller() -> Caller {
    Caller::trusted_user("hivemind-store")
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn turn_fingerprint<'a>(
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

fn snapshot_fingerprint(snapshot: &RoomSnapshot) -> Result<u64> {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_vec(snapshot)?.hash(&mut hasher);
    Ok(hasher.finish())
}

/// Groups events by turn id, preserving first-seen turn order.
fn events_by_turn(events: &[MessageEvent]) -> (Vec<String>, HashMap<String, Vec<&MessageEvent>>) {
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

fn turn_participants(events: &[&MessageEvent]) -> Vec<ArchiveParticipant> {
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

fn turn_messages(room: &str, turn_id: &str, events: &[&MessageEvent]) -> Vec<ArchivedMessage> {
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

fn snapshot_from_history(history: &RoomHistory) -> Result<RoomSnapshot> {
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

pub struct TurnRequest<'a> {
    pub room: &'a str,
    pub room_name: &'a str,
    pub group_id: &'a str,
    pub mode: ConversationMode,
    pub members: &'a [Participant],
    pub input: &'a str,
    pub invoker: Arc<dyn AgentInvoker>,
}

/// Owns durable room history and all turn/context orchestration; runtime sessions are disposable.
pub struct ConversationCoordinator {
    store: Arc<dyn ContextStore>,
    memory: Arc<MemoryService>,
    limits: ContextConfig,
    events: Option<crate::events::EventBus>,
}

struct PackRequest<'a> {
    history: &'a RoomHistory,
    room_name: &'a str,
    members: &'a [Participant],
    current: &'a Participant,
    input: &'a str,
    prior: &'a [(String, Result<String, String>)],
    active_turn: &'a str,
    caller: &'a Caller,
}

/// Prompts prepared for one member's invocation this turn.
struct MemberPrompt {
    /// Self-contained Context Pack used whenever the runtime (re)hydrates.
    pack: String,
    /// `(epoch_id, text)` continuation for the live session, when buildable.
    delta: Option<(String, String)>,
    /// Room view the session holds after it replies.
    view: TurnView,
}

/// Delta sections cannot restate the manifest; they point back at it.
const SESSION_TOOL_REMINDER: &str =
    "\nHivemind memory tools remain available exactly as described at the start of this session.\n";

/// Earlier same-turn replies (Discussion mode), rendered identically for
/// full packs and deltas.
fn same_turn_replies(prior: &[(String, Result<String, String>)]) -> String {
    let peers = prior
        .iter()
        .map(|(name, result)| match result {
            Ok(reply) => format!("{name}: {reply}\n"),
            Err(_) => format!("{name} failed to produce a response for this turn.\n"),
        })
        .collect::<String>();
    if peers.is_empty() {
        String::new()
    } else {
        format!("\nEarlier replies in this turn:\n{peers}")
    }
}

impl ConversationCoordinator {
    /// SQLite (L7 archive) is the single source of truth for room history;
    /// `memory` is the one service opened at process startup.
    pub fn new(
        directory: impl Into<PathBuf>,
        limits: ContextConfig,
        memory: Arc<MemoryService>,
    ) -> Self {
        Self::new_with_events(directory, limits, memory, None)
    }
    pub fn new_with_events(
        directory: impl Into<PathBuf>,
        limits: ContextConfig,
        memory: Arc<MemoryService>,
        events: Option<crate::events::EventBus>,
    ) -> Self {
        Self {
            store: Arc::new(SqliteContextStore::new(directory, memory.clone())),
            memory,
            limits,
            events,
        }
    }
    #[cfg(test)]
    pub fn with_store(
        store: Arc<dyn ContextStore>,
        limits: ContextConfig,
        memory: Arc<MemoryService>,
    ) -> Self {
        Self {
            store,
            memory,
            limits,
            events: None,
        }
    }
    /// The shared memory service this coordinator executes tool calls against.
    #[cfg(test)]
    pub fn memory(&self) -> Arc<MemoryService> {
        self.memory.clone()
    }
    pub fn room_history(&self, room: &str) -> Result<RoomHistory> {
        self.store.load_room(room)
    }

    fn save(&self, history: &RoomHistory, room: &str) -> Result<()> {
        self.store.save_room(room, history)
    }

    pub async fn turn(&self, request: TurnRequest<'_>) -> Result<Vec<TurnReply>> {
        let TurnRequest {
            room,
            room_name,
            group_id,
            mode,
            members,
            input,
            invoker,
        } = request;
        let room_lock = room_mutex(self.store.directory(), room).await?;
        let _in_process = room_lock.lock().await;
        let _file_lock = acquire_file_lock(self.store.directory(), room).await?;
        let mut history = self.room_history(room)?;
        if self.refresh_summary(&mut history) {
            self.save(&history, room)?;
        }
        let turn_id = stable_id();
        if let Some(events) = &self.events {
            events.publish(crate::events::DomainEventKind::TurnStarted {
                turn_id: turn_id.clone(),
                room_id: room.to_owned(),
            });
        }
        let user_message_id = stable_id();
        history.events.push(MessageEvent {
            id: user_message_id.clone(),
            turn_id: turn_id.clone(),
            speaker: "user".into(),
            agent_instance_id: None,
            content: input.into(),
            error: false,
        });
        self.save(&history, room)?;
        // Explicit structured directive from the raw user input only; may
        // authorize exactly one exact-content global proposal this turn.
        let authorized_global = authorized_global_directive(input);
        let mut replies = Vec::with_capacity(members.len());
        match mode {
            ConversationMode::Broadcast => {
                let mut jobs = JoinSet::new();
                let mut task_names = HashMap::new();
                for member in members {
                    let caller = invocation_caller(
                        room,
                        group_id,
                        &member.agent.name,
                        &turn_id,
                        &user_message_id,
                    );
                    let instance_id = format!("{room}/{}", member.agent.name);
                    let cursor = invoker.cursor(&instance_id).await;
                    let prompt = self.member_prompt(
                        &PackRequest {
                            history: &history,
                            room_name,
                            members,
                            current: member,
                            input,
                            prior: &[],
                            active_turn: &turn_id,
                            caller: &caller,
                        },
                        cursor,
                    );
                    let (name, prompt) = match prompt {
                        Ok(prompt) => (member.agent.name.clone(), prompt),
                        Err(error) => {
                            let name = member.agent.name.clone();
                            if let Some(events) = &self.events {
                                events.publish(crate::events::DomainEventKind::AgentReplyStarted {
                                    turn_id: turn_id.clone(),
                                    room_id: room.to_owned(),
                                    agent_id: name.clone(),
                                    instance_id: instance_id.clone(),
                                });
                                events.publish(crate::events::DomainEventKind::AgentReplyFailed {
                                    turn_id: turn_id.clone(),
                                    room_id: room.to_owned(),
                                    agent_id: name.clone(),
                                    instance_id,
                                    error_code: "context_build_failed".into(),
                                    message: "agent context could not be built".into(),
                                });
                            }
                            replies.push(TurnReply {
                                name,
                                result: Err(format!("context pack: {error:#}")),
                            });
                            continue;
                        }
                    };
                    if let Some(events) = &self.events {
                        events.publish(crate::events::DomainEventKind::AgentReplyStarted {
                            turn_id: turn_id.clone(),
                            room_id: room.to_owned(),
                            agent_id: name.clone(),
                            instance_id: format!("{room}/{name}"),
                        });
                    }
                    let invoker = invoker.clone();
                    let agent = member.agent.clone();
                    let room = room.to_owned();
                    let memory = self.memory.clone();
                    let authorized_global = authorized_global.clone();
                    let task_name = name.clone();
                    let handle = jobs.spawn(async move {
                        let MemberPrompt { pack, delta, view } = prompt;
                        let result = invoke_with_memory(
                            &*invoker,
                            &format!("{room}/{}", agent.name),
                            &agent,
                            &pack,
                            delta
                                .as_ref()
                                .map(|(epoch_id, text)| PromptDelta { epoch_id, text }),
                            &view,
                            &caller,
                            &memory,
                            authorized_global.as_deref(),
                        )
                        .await
                        .map_err(|e| format!("{e:#}"));
                        (name, result)
                    });
                    task_names.insert(handle.id(), task_name);
                }
                let mut by_name = HashMap::new();
                while let Some(joined) = jobs.join_next_with_id().await {
                    let (name, result) = match joined {
                        Ok((id, (name, result))) => {
                            task_names.remove(&id);
                            (name, result)
                        }
                        Err(error) => {
                            let name = task_names
                                .remove(&error.id())
                                .unwrap_or_else(|| "unknown agent".into());
                            (name, Err(format!("agent task failed: {error}")))
                        }
                    };
                    if let Some(events) = &self.events {
                        let event = if result.is_ok() {
                            crate::events::DomainEventKind::AgentReplyCompleted {
                                turn_id: turn_id.clone(),
                                room_id: room.to_owned(),
                                agent_id: name.clone(),
                                instance_id: format!("{room}/{name}"),
                            }
                        } else {
                            crate::events::DomainEventKind::AgentReplyFailed {
                                turn_id: turn_id.clone(),
                                room_id: room.to_owned(),
                                agent_id: name.clone(),
                                instance_id: format!("{room}/{name}"),
                                error_code: "agent_reply_failed".into(),
                                message: "agent failed to produce a reply".into(),
                            }
                        };
                        events.publish(event);
                    }
                    append_reply(&mut history, room, &turn_id, &name, &result);
                    self.save(&history, room)?;
                    by_name.insert(name, result);
                }
                for member in members {
                    let name = member.agent.name.clone();
                    let result = by_name
                        .remove(&name)
                        .or_else(|| {
                            replies
                                .iter()
                                .find(|reply: &&TurnReply| reply.name == name)
                                .map(|reply| reply.result.clone())
                        })
                        .unwrap_or_else(|| Err("agent task did not return".into()));
                    if !replies.iter().any(|reply| reply.name == name) {
                        replies.push(TurnReply { name, result });
                    }
                }
                replies.sort_by_key(|reply| {
                    members
                        .iter()
                        .position(|member| member.agent.name == reply.name)
                        .unwrap_or(usize::MAX)
                });
            }
            ConversationMode::Discussion => {
                let mut prior = Vec::new();
                for member in members {
                    let caller = invocation_caller(
                        room,
                        group_id,
                        &member.agent.name,
                        &turn_id,
                        &user_message_id,
                    );
                    let name = member.agent.name.clone();
                    if let Some(events) = &self.events {
                        events.publish(crate::events::DomainEventKind::AgentReplyStarted {
                            turn_id: turn_id.clone(),
                            room_id: room.to_owned(),
                            agent_id: name.clone(),
                            instance_id: format!("{room}/{name}"),
                        });
                    }
                    let instance_id = format!("{room}/{name}");
                    let cursor = invoker.cursor(&instance_id).await;
                    let result = match self.member_prompt(
                        &PackRequest {
                            history: &history,
                            room_name,
                            members,
                            current: member,
                            input,
                            prior: &prior,
                            active_turn: &turn_id,
                            caller: &caller,
                        },
                        cursor,
                    ) {
                        Ok(MemberPrompt { pack, delta, view }) => invoke_with_memory(
                            &*invoker,
                            &instance_id,
                            &member.agent,
                            &pack,
                            delta
                                .as_ref()
                                .map(|(epoch_id, text)| PromptDelta { epoch_id, text }),
                            &view,
                            &caller,
                            &self.memory,
                            authorized_global.as_deref(),
                        )
                        .await
                        .map_err(|e| format!("{e:#}")),
                        Err(error) => Err(format!("context pack: {error:#}")),
                    };
                    if let Some(events) = &self.events {
                        let event = if result.is_ok() {
                            crate::events::DomainEventKind::AgentReplyCompleted {
                                turn_id: turn_id.clone(),
                                room_id: room.to_owned(),
                                agent_id: name.clone(),
                                instance_id: format!("{room}/{name}"),
                            }
                        } else {
                            crate::events::DomainEventKind::AgentReplyFailed {
                                turn_id: turn_id.clone(),
                                room_id: room.to_owned(),
                                agent_id: name.clone(),
                                instance_id: format!("{room}/{name}"),
                                error_code: "agent_reply_failed".into(),
                                message: "agent failed to produce a reply".into(),
                            }
                        };
                        events.publish(event);
                    }
                    append_reply(&mut history, room, &turn_id, &name, &result);
                    self.save(&history, room)?;
                    prior.push((name.clone(), result.clone()));
                    replies.push(TurnReply { name, result });
                }
            }
        }
        for reply in &replies {
            if !history
                .events
                .iter()
                .any(|event| event.turn_id == turn_id && event.speaker == reply.name)
            {
                append_reply(&mut history, room, &turn_id, &reply.name, &reply.result);
            }
        }
        history.completed_turns.push(turn_id.clone());
        let mut next_state = history.state.clone();
        let state_update = apply_explicit_state_updates(&mut next_state, input).and_then(|()| {
            validate_state(
                &next_state,
                self.limits.context_target_tokens.saturating_mul(2),
            )
        });
        if let Err(error) = state_update {
            record_maintenance_error(
                &mut history,
                format!("state update rejected for turn {turn_id}: {error:#}"),
            );
        } else {
            if !group_id.is_empty() {
                // Explicit assignments are user directives: a host caller
                // with structured-project-event provenance, actor "user",
                // bound to the assignee's instance. Solo/main rooms stay
                // room-scoped and never write these notes.
                for (persona, task) in next_state.assignments.iter() {
                    if history.state.assignments.get(persona) == Some(task)
                        || !members.iter().any(|member| member.agent.name == *persona)
                    {
                        continue;
                    }
                    let assignee =
                        user_directive_caller(room, group_id, persona, &turn_id, &user_message_id);
                    let note = MemoryWrite {
                        id: None,
                        kind: "assignment".into(),
                        content: format!("Assigned: {task}"),
                        provenance: Provenance::default(),
                        importance: 60,
                        supersedes_memory_id: None,
                    };
                    if let Err(error) = replace_active_assignment(&self.memory, &assignee, note) {
                        record_maintenance_error(
                            &mut history,
                            format!("assignment note for '{persona}' rejected: {error:#}"),
                        );
                    }
                }
                // Group rooms persist accepted directives as canonical group
                // state, attributed to the directive's author: the user.
                let group_caller =
                    user_directive_caller(room, group_id, "", &turn_id, &user_message_id);
                if let Err(error) = self
                    .memory
                    .set_group_state(&group_caller, serde_json::to_value(&next_state)?)
                {
                    record_maintenance_error(
                        &mut history,
                        format!("group state update rejected: {error:#}"),
                    );
                }
            }
            history.state = next_state;
        }
        self.refresh_summary(&mut history);
        self.save(&history, room)?;
        if let Some(events) = &self.events {
            events.publish(crate::events::DomainEventKind::TurnCompleted {
                turn_id: turn_id.clone(),
                room_id: room.to_owned(),
                reply_count: replies.len(),
            });
        }
        Ok(replies)
    }

    /// Serialized shared state shown to `caller`: canonical group state for
    /// group callers, the room-scoped conversation snapshot otherwise.
    fn state_json(&self, history: &RoomHistory, caller: &Caller) -> Result<String> {
        let state_value = if caller.group_id.is_empty() {
            serde_json::to_value(&history.state)?
        } else {
            match self.memory.group_state(caller) {
                Ok(Some(record)) => record.state,
                _ => serde_json::to_value(&history.state)?,
            }
        };
        Ok(serde_json::to_string(&state_value)?)
    }

    /// Full pack, optional epoch-bound delta, and the room view the member's
    /// session holds once it replies.
    fn member_prompt(
        &self,
        request: &PackRequest<'_>,
        cursor: Option<SessionCursor>,
    ) -> Result<MemberPrompt> {
        let state_json = self.state_json(request.history, request.caller)?;
        let pack = self.context_pack(request, &state_json)?;
        let delta = cursor.and_then(|cursor| {
            self.turn_delta(request, &cursor.view, &state_json)
                .map(|text| (cursor.epoch_id, text))
        });
        let mut speakers = Vec::with_capacity(request.prior.len() + 2);
        speakers.push("user".to_owned());
        speakers.extend(request.prior.iter().map(|(name, _)| name.clone()));
        speakers.push(request.current.agent.name.clone());
        Ok(MemberPrompt {
            pack,
            delta,
            view: TurnView {
                turn_id: request.active_turn.to_owned(),
                speakers,
                state_json,
            },
        })
    }

    /// Room delta for a live session whose view is `cursor`, or `None` when
    /// the session cannot be continued (its view fell out of history, or the
    /// delta would exceed the context budget) and must rehydrate.
    fn turn_delta(
        &self,
        request: &PackRequest<'_>,
        cursor: &TurnView,
        state_json: &str,
    ) -> Option<String> {
        let PackRequest {
            history,
            input,
            prior,
            active_turn,
            caller,
            ..
        } = *request;
        let start = history
            .events
            .iter()
            .position(|event| event.turn_id == cursor.turn_id)?;
        let lines = history.events[start..]
            .iter()
            .filter(|event| event.turn_id != active_turn)
            .filter(|event| {
                event.turn_id != cursor.turn_id || !cursor.speakers.contains(&event.speaker)
            })
            .map(|event| format!("{}: {}", event.speaker, event.content))
            .collect::<Vec<_>>()
            .join("\n");
        let mut delta = String::new();
        if !lines.is_empty() {
            delta.push_str(&format!("Room update since your last reply:\n{lines}\n"));
        }
        if state_json != cursor.state_json {
            delta.push_str(&format!("\nShared room state:\n{state_json}\n"));
        }
        delta.push_str(&self.memory_retrieval(caller, input, active_turn));
        delta.push_str(SESSION_TOOL_REMINDER);
        delta.push_str(&format!("\nCurrent user message:\n{input}\n"));
        delta.push_str(&same_turn_replies(prior));
        (delta.len() <= self.limits.context_target_tokens.saturating_mul(4)).then_some(delta)
    }

    fn context_pack(&self, request: &PackRequest<'_>, state_json: &str) -> Result<String> {
        let PackRequest {
            history,
            room_name,
            members,
            current,
            input,
            prior,
            active_turn,
            caller,
        } = *request;
        let roster = members
            .iter()
            .map(|p| {
                format!(
                    "- {} — {}",
                    p.agent.name,
                    p.role
                        .as_deref()
                        .or(p.agent.role.as_deref())
                        .unwrap_or("participant")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let identity = format!("You are participating in {room_name}.\n\nParticipants:\n{roster}\n\nYou are {}. Your room role is {}.\n", current.agent.name, current.role.as_deref().or(current.agent.role.as_deref()).unwrap_or("participant"));
        let manifest = format!("\n{}", memory_tool_manifest(caller));
        let state = format!("\nShared room state:\n{state_json}\n");
        let summary = if history.summary.is_empty() {
            String::new()
        } else {
            format!("\nOlder conversation summary:\n{}\n", history.summary)
        };
        let recent = recent_events(&history.events, self.limits.recent_turns, active_turn);
        let recent = if recent.is_empty() {
            String::new()
        } else {
            format!("\nRecent conversation:\n{recent}\n")
        };
        // Bounded retrieval over the caller's authorized scopes only; current-turn
        // messages are excluded so the input is never echoed back as a "memory".
        let hits = self.memory_retrieval(caller, input, active_turn);
        let current = format!("\nCurrent user message:\n{input}\n");
        let same_turn = same_turn_replies(prior);
        let mandatory_len =
            identity.len() + manifest.len() + state.len() + current.len() + same_turn.len();
        // Established byte budget: four times the configured token target,
        // enforced before any optional section is assembled.
        let budget = self.limits.context_target_tokens.saturating_mul(4);
        if mandatory_len > budget {
            bail!("current turn and participant/state context exceed configured context_target_tokens ({})", self.limits.context_target_tokens);
        }
        let available = budget - mandatory_len;
        let mut optional = format!("{summary}{recent}{hits}");
        if optional.len() > available {
            let keep_recent = recent.len().min(available);
            let keep_summary = available.saturating_sub(keep_recent);
            optional = format!(
                "{}{}",
                utf8_suffix(&summary, keep_summary),
                utf8_suffix(&recent, keep_recent)
            );
        }
        Ok(format!(
            "{identity}{manifest}{state}{optional}{current}{same_turn}"
        ))
    }

    /// Deterministic, bounded retrieval of authorized group/private/persona/
    /// global/current-room archive results for this agent's own identity.
    /// Search failure or no results inject nothing (the agent is never told
    /// memory was found when it was not).
    fn memory_retrieval(&self, caller: &Caller, input: &str, active_turn: &str) -> String {
        let query = input.trim().to_owned();
        if query.is_empty() {
            return String::new();
        }
        let results = match self.memory.search(
            caller,
            &SearchRequest {
                query,
                scopes: default_search_scopes(caller),
                limit: 8,
                include_historical: false,
            },
        ) {
            Ok(results) => results,
            Err(_) => return String::new(),
        };
        let mut lines = Vec::new();
        for result in results
            .iter()
            .filter(|result| {
                result.record.provenance.source_turn_id.as_deref() != Some(active_turn)
            })
            .take(8)
        {
            lines.push(format!(
                "- [{}] {}{}",
                layer_label(result.record.layer),
                utf8_suffix(&result.record.content, 300),
                source_suffix(&result.record.provenance)
            ));
        }
        if lines.is_empty() {
            return String::new();
        }
        format!("\nRelevant Hivemind memory:\n{}\n", lines.join("\n"))
    }

    fn refresh_summary(&self, history: &mut RoomHistory) -> bool {
        let mut turn_ids = Vec::new();
        let mut seen = HashSet::new();
        for event in &history.events {
            if seen.insert(event.turn_id.as_str()) {
                turn_ids.push(event.turn_id.as_str());
            }
        }
        let archive_count = turn_ids.len().saturating_sub(self.limits.recent_turns);
        if archive_count == 0 {
            return false;
        }
        let completed = history.completed_turns.len();
        let cadence_due =
            completed > 0 && completed.is_multiple_of(self.limits.summary_refresh_turns);
        let raw_window_would_evict_unrepresented_turn =
            archive_count > history.summarized_turn_count;
        if !cadence_due && !raw_window_would_evict_unrepresented_turn {
            return false;
        }
        let archived: HashSet<_> = turn_ids[..archive_count].iter().copied().collect();
        let narrative = history
            .events
            .iter()
            .filter(|event| archived.contains(event.turn_id.as_str()))
            .map(|event| format!("{}: {}", event.speaker, event.content))
            .collect::<Vec<_>>()
            .join("\n");
        history.summary = utf8_suffix(&narrative, self.limits.summary_max_tokens.saturating_mul(4));
        history.summarized_turn_count = archive_count;
        true
    }
}

fn append_unique(values: &mut Vec<String>, value: &str) {
    if !values.iter().any(|existing| existing == value) {
        values.push(value.to_owned());
    }
}

/// Apply only documented user-input directives, never successful agent prose.
fn apply_explicit_state_updates(state: &mut RoomState, text: &str) -> Result<()> {
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

fn validate_state(state: &RoomState, max_serialized_bytes: usize) -> Result<()> {
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

fn record_maintenance_error(history: &mut RoomHistory, message: String) {
    eprintln!("hivemind: {message}");
    history.maintenance_errors.push(message);
    if history.maintenance_errors.len() > 64 {
        history.maintenance_errors.remove(0);
    }
}

fn append_reply(
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
        agent_instance_id: Some(format!("{room}/{speaker}")),
        content: result
            .clone()
            .unwrap_or_else(|error| format!("[agent failure: {error}]")),
        error: result.is_err(),
    });
}

fn recent_events(events: &[MessageEvent], turns: usize, active_turn: &str) -> String {
    if turns == 0 {
        return String::new();
    }
    let mut ids = Vec::new();
    for event in events
        .iter()
        .rev()
        .filter(|event| event.turn_id != active_turn)
    {
        if ids.last() != Some(&event.turn_id) {
            ids.push(event.turn_id.clone());
        }
        if ids.len() >= turns {
            break;
        }
    }
    let selected: HashSet<_> = ids.into_iter().collect();
    events
        .iter()
        .filter(|event| selected.contains(&event.turn_id))
        .map(|event| format!("{}: {}", event.speaker, event.content))
        .collect::<Vec<_>>()
        .join("\n")
}

fn utf8_suffix(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_owned();
    }
    let mut start = text.len() - max_bytes;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_owned()
}

fn stable_id() -> String {
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
fn id_timestamp(id: &str) -> i64 {
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

/// Tool manifest for callers whose route has a configured group.
const GROUP_MEMORY_TOOL_MANIFEST: &str = "\
Hivemind memory tools — at most one call per reply, as exactly one fenced block:\n\
```hivemind-tool\n\
{\"name\":\"memory.search\",\"args\":{\"query\":\"...\",\"scopes\":[\"group\",\"private\",\"persona\",\"global\",\"archive\"],\"limit\":8}}\n\
```\n\
\n\
Available tools: memory.search(query,scopes,limit) · memory.private.add(content) · memory.private.update(id,content) · memory.group.add(content) · memory.group.update(id,content) · memory.persona.propose(content) · memory.global.propose(content) · memory.archive(id)\n\
Hivemind binds every call to your current room, group, instance, and persona — never send scope or owner ids. private = this instance only; group = your room's group; persona and global memories have far broader visibility across Hivemind, so those writes are proposals subject to stricter deterministic validation. memory.global.propose is accepted only when its content exactly matches the trimmed payload of a `Global:` directive in the current user turn; every other global proposal is rejected. Search before claiming to remember; never invent results.\n";

/// Tool manifest for groupless callers (main and solo rooms): no group tools or scope.
const ROOM_MEMORY_TOOL_MANIFEST: &str = "\
Hivemind memory tools — at most one call per reply, as exactly one fenced block:\n\
```hivemind-tool\n\
{\"name\":\"memory.search\",\"args\":{\"query\":\"...\",\"scopes\":[\"private\",\"persona\",\"global\",\"archive\"],\"limit\":8}}\n\
```\n\
\n\
Available tools: memory.search(query,scopes,limit) · memory.private.add(content) · memory.private.update(id,content) · memory.persona.propose(content) · memory.global.propose(content) · memory.archive(id)\n\
Hivemind binds every call to your current room, instance, and persona — never send scope or owner ids. This room has no group, so there is no group memory; never claim to have saved group memory. private = this instance only; persona and global memories have far broader visibility across Hivemind, so those writes are proposals subject to stricter deterministic validation. memory.global.propose is accepted only when its content exactly matches the trimmed payload of a `Global:` directive in the current user turn; every other global proposal is rejected. Search before claiming to remember; never invent results.\n";

/// Hivemind-generated tool manifest; never persona-specific. Group tools
/// appear only when the route has a configured group, mirroring
/// `default_search_scopes`.
fn memory_tool_manifest(caller: &Caller) -> &'static str {
    if caller.group_id.is_empty() {
        ROOM_MEMORY_TOOL_MANIFEST
    } else {
        GROUP_MEMORY_TOOL_MANIFEST
    }
}

/// Memory actions allowed per agent invocation before a plain-text answer is required.
const MAX_MEMORY_ACTIONS: usize = 4;

/// A parsed model tool request: a name from the fixed allowlist and its args.
/// Scope, room, group, instance, persona, and actor are never read from here.
#[derive(Debug, Clone, PartialEq)]
struct MemoryToolCall {
    name: String,
    args: serde_json::Value,
}

/// Extract exactly one `hivemind-tool` fence from an assistant reply.
/// `Ok(None)` means a normal text answer; malformed or ambiguous output is an
/// error the loop feeds back to the agent instead of guessing an action.
fn parse_tool_block(text: &str) -> Result<Option<MemoryToolCall>> {
    let mut blocks = Vec::new();
    let mut open = false;
    let mut buffer = String::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if !open && trimmed == "```hivemind-tool" {
            open = true;
            buffer.clear();
            continue;
        }
        if open && trimmed == "```" {
            open = false;
            blocks.push(std::mem::take(&mut buffer));
            continue;
        }
        if open {
            buffer.push_str(line);
            buffer.push('\n');
        }
    }
    if open {
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

fn required_string(args: &serde_json::Value, key: &str) -> Result<String> {
    args.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .with_context(|| format!("tool argument '{key}' must be a non-empty string"))
}

fn optional_string(args: &serde_json::Value, key: &str) -> Result<Option<String>> {
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
fn tool_write(args: &serde_json::Value, target: Option<String>) -> Result<MemoryWrite> {
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

fn parse_scope_alias(alias: &str) -> Result<SearchScope> {
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
fn default_search_scopes(caller: &Caller) -> Vec<SearchScope> {
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

fn layer_label(layer: Layer) -> &'static str {
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
fn source_suffix(provenance: &Provenance) -> String {
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

/// Execute one parsed tool call against the shared MemoryService. The caller
/// is Hivemind-created; every scope decision happens inside the service.
fn execute_memory_tool(
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
                .map(|result| {
                    let record = &result.record;
                    format!(
                        "- [{}] {}{}",
                        layer_label(record.layer),
                        utf8_suffix(&record.content, 300),
                        source_suffix(&record.provenance)
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            Ok(format!("{} memory results:\n{lines}", results.len()))
        }
        "memory.private.add" => {
            let record = memory.add_private(caller, tool_write(&call.args, None)?)?;
            Ok(format!("stored private memory {}", record.id))
        }
        "memory.private.update" => {
            let id = required_string(&call.args, "id")?;
            let record =
                memory.update_private(caller, &id, tool_write(&call.args, Some(id.clone()))?)?;
            Ok(format!("updated private memory {}", record.id))
        }
        "memory.group.add" => {
            let record = memory.add_group(caller, tool_write(&call.args, None)?)?;
            Ok(format!("stored group memory {}", record.id))
        }
        "memory.group.update" => {
            let id = required_string(&call.args, "id")?;
            let record =
                memory.update_group(caller, &id, tool_write(&call.args, Some(id.clone()))?)?;
            Ok(format!("updated group memory {}", record.id))
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
fn tool_prompt(pack: &str, exchange: &[(String, String)]) -> String {
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
fn tool_followup(call: &str, result: &str) -> String {
    format!("Memory tool result:\n- requested: {call}\n- result: {result}\nRespond with either exactly one ```hivemind-tool fenced block or the final answer as plain text.\n")
}

/// Server-created invocation context for one agent, one turn: identity and
/// provenance come from the room/turn Hivemind is executing — never from
/// model-supplied tool arguments.
fn invocation_caller(
    room: &str,
    group_id: &str,
    persona_id: &str,
    turn_id: &str,
    message_id: &str,
) -> Caller {
    Caller::agent(
        room,
        group_id,
        format!("{room}/{persona_id}"),
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
fn user_directive_caller(
    room: &str,
    group_id: &str,
    persona: &str,
    turn_id: &str,
    message_id: &str,
) -> Caller {
    let instance_id = if persona.is_empty() {
        String::new()
    } else {
        format!("{room}/{persona}")
    };
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
fn replace_active_assignment(
    memory: &MemoryService,
    assignee: &Caller,
    note: MemoryWrite,
) -> Result<()> {
    let scope = Scope::AgentInstance(assignee.instance_id.clone());
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
fn authorized_global_directive(input: &str) -> Option<String> {
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
fn execute_with_optional_authorization(
    memory: &MemoryService,
    caller: &Caller,
    authorized_global: Option<&str>,
    call: &MemoryToolCall,
) -> Result<String> {
    let exact = authorized_global.filter(|exact| {
        call.name == "memory.global.propose"
            && call
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
async fn invoke_with_memory(
    invoker: &dyn AgentInvoker,
    instance_id: &str,
    agent: &AgentConfig,
    pack: &str,
    delta: Option<PromptDelta<'_>>,
    view: &TurnView,
    caller: &Caller,
    memory: &MemoryService,
    authorized_global: Option<&str>,
) -> Result<String> {
    let mut exchange: Vec<(String, String)> = Vec::new();
    let mut last = invoker
        .invoke(InvokeRequest {
            instance_id,
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
        let outcome = parse_tool_block(reply);
        let call = match outcome {
            Ok(None) => return Ok(last.text),
            Ok(Some(call)) => Ok(call),
            Err(error) => Err(format!("{error:#}")),
        };
        if actions >= MAX_MEMORY_ACTIONS {
            bail!(
                "agent hit the Hivemind memory tool action limit ({MAX_MEMORY_ACTIONS}) without producing a plain-text answer"
            );
        }
        actions += 1;
        let (rendered, result) = match call {
            Ok(call) => {
                let rendered = serde_json::to_string(&call.args)
                    .map(|args| format!("{{\"name\":\"{}\",\"args\":{args}}}", call.name))
                    .unwrap_or_else(|_| call.name.clone());
                match execute_with_optional_authorization(memory, caller, authorized_global, &call)
                {
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
                instance_id,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{MemoryStatus, MemoryStore, Scope};
    use parking_lot::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fake {
        prompts: Mutex<Vec<(String, String)>>,
        running: AtomicUsize,
        max_running: AtomicUsize,
        fail: Option<String>,
        barrier: Option<Arc<tokio::sync::Barrier>>,
        reply: Mutex<Option<String>>,
    }
    #[async_trait]
    impl AgentInvoker for Fake {
        async fn cursor(&self, _instance_id: &str) -> Option<SessionCursor> {
            None
        }

        async fn invoke(&self, request: InvokeRequest<'_>) -> Result<InvokeReply> {
            let agent = request.agent;
            let now = self.running.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_running.fetch_max(now, Ordering::SeqCst);
            self.prompts
                .lock()
                .push((request.instance_id.to_owned(), request.full.to_owned()));
            let synchronized = if let Some(barrier) = &self.barrier {
                tokio::time::timeout(std::time::Duration::from_secs(2), barrier.wait())
                    .await
                    .is_ok()
            } else {
                tokio::task::yield_now().await;
                true
            };
            self.running.fetch_sub(1, Ordering::SeqCst);
            if !synchronized {
                anyhow::bail!("different room invocations did not meet at the barrier");
            }
            if self.fail.as_deref() == Some(&agent.name) {
                anyhow::bail!("fixture failure");
            }
            let text = self
                .reply
                .lock()
                .clone()
                .unwrap_or_else(|| format!("{} answered", agent.name));
            Ok(InvokeReply {
                text,
                epoch_id: "fake".into(),
            })
        }
    }
    fn member(name: &str) -> Participant {
        Participant {
            agent: AgentConfig {
                name: name.into(),
                runtime: "pi".into(),
                system_prompt: String::new(),
                workspace: ".".into(),
                model: None,
                reasoning: None,
                fast: None,
                role: None,
            },
            role: Some(format!("{name} role")),
        }
    }
    fn fixture() -> (PathBuf, ConversationCoordinator) {
        let path = std::env::temp_dir().join(format!("hivemind-context-test-{}", stable_id()));
        let coord = ConversationCoordinator::new(
            &path,
            ContextConfig {
                recent_turns: 1,
                summary_max_tokens: 100,
                context_target_tokens: 1000,
                runtime_rotate_tokens: 24000,
                summary_refresh_turns: 2,
            },
            in_memory_memory(),
        );
        (path, coord)
    }

    fn in_memory_memory() -> Arc<MemoryService> {
        Arc::new(MemoryService::new(MemoryStore::in_memory().unwrap()))
    }
    fn fake(fail: Option<&str>) -> Arc<Fake> {
        fake_with(fail, None)
    }
    fn fake_with(fail: Option<&str>, barrier: Option<Arc<tokio::sync::Barrier>>) -> Arc<Fake> {
        Arc::new(Fake {
            prompts: Mutex::new(Vec::new()),
            running: AtomicUsize::new(0),
            max_running: AtomicUsize::new(0),
            fail: fail.map(str::to_owned),
            reply: Mutex::new(None),
            barrier,
        })
    }

    struct DelayedEventsInvoker;

    #[async_trait]
    impl AgentInvoker for DelayedEventsInvoker {
        async fn cursor(&self, _instance_id: &str) -> Option<SessionCursor> {
            None
        }

        async fn invoke(&self, request: InvokeRequest<'_>) -> Result<InvokeReply> {
            let agent = request.agent;
            let delay = if agent.name == "Slow" { 60 } else { 5 };
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            if agent.name == "Fails" {
                anyhow::bail!("sensitive provider detail");
            }
            Ok(InvokeReply {
                text: format!("{} reply", agent.name),
                epoch_id: "fake".into(),
            })
        }
    }

    #[tokio::test]
    async fn broadcast_events_track_completion_order_and_safe_attributed_failures() {
        let path = std::env::temp_dir().join(format!("hivemind-event-turn-{}", stable_id()));
        let events = crate::events::EventBus::new();
        let mut receiver = events.subscribe();
        let coordinator = ConversationCoordinator::new_with_events(
            &path,
            ContextConfig::default(),
            in_memory_memory(),
            Some(events),
        );
        let members = [member("Slow"), member("Fast")];
        let replies = coordinator
            .turn(TurnRequest {
                room: "event-room",
                room_name: "Event room",
                group_id: "group-1",
                mode: ConversationMode::Broadcast,
                members: &members,
                input: "question",
                invoker: Arc::new(DelayedEventsInvoker),
            })
            .await
            .unwrap();

        assert_eq!(
            replies
                .iter()
                .map(|reply| reply.name.as_str())
                .collect::<Vec<_>>(),
            ["Slow", "Fast"]
        );
        let mut seen = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            seen.push(event.payload);
        }
        let (turn_id, room_id) = seen
            .iter()
            .find_map(|event| match event {
                crate::events::DomainEventKind::TurnStarted { turn_id, room_id } => {
                    Some((turn_id.clone(), room_id.clone()))
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(room_id, "event-room");
        let completed_order = seen
            .iter()
            .filter_map(|event| match event {
                crate::events::DomainEventKind::AgentReplyCompleted {
                    turn_id: observed_turn,
                    room_id: observed_room,
                    agent_id,
                    instance_id,
                } => {
                    assert_eq!(observed_turn, &turn_id);
                    assert_eq!(observed_room, "event-room");
                    assert_eq!(instance_id, &format!("event-room/{agent_id}"));
                    Some(agent_id.as_str())
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(completed_order, ["Fast", "Slow"]);
        let saved = coordinator.room_history("event-room").unwrap();
        assert!(saved.completed_turns.contains(&turn_id));
        assert!(matches!(
            seen.last(),
            Some(crate::events::DomainEventKind::TurnCompleted { turn_id: completed, .. })
                if completed == &turn_id
        ));

        let failing_path = path.with_extension("failure");
        let failing_events = crate::events::EventBus::new();
        let mut failure_receiver = failing_events.subscribe();
        let failing = ConversationCoordinator::new_with_events(
            &failing_path,
            ContextConfig::default(),
            in_memory_memory(),
            Some(failing_events),
        );
        let failed_members = [member("Fails")];
        let failed = failing
            .turn(TurnRequest {
                room: "failure-room",
                room_name: "Failure room",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &failed_members,
                input: "question",
                invoker: Arc::new(DelayedEventsInvoker),
            })
            .await
            .unwrap();
        assert!(failed[0]
            .result
            .as_ref()
            .unwrap_err()
            .contains("sensitive provider detail"));
        let failed_event = loop {
            match failure_receiver.try_recv() {
                Ok(crate::events::DomainEvent {
                    payload:
                        crate::events::DomainEventKind::AgentReplyFailed {
                            turn_id,
                            room_id,
                            agent_id,
                            instance_id,
                            error_code,
                            message,
                        },
                    ..
                }) => break (turn_id, room_id, agent_id, instance_id, error_code, message),
                Ok(_) => continue,
                Err(error) => panic!("missing reply failure event: {error}"),
            }
        };
        assert_eq!(failed_event.1, "failure-room");
        assert_eq!(failed_event.2, "Fails");
        assert_eq!(failed_event.3, "failure-room/Fails");
        assert_eq!(failed_event.4, "agent_reply_failed");
        assert_eq!(failed_event.5, "agent failed to produce a reply");
        assert!(!failed_event.5.contains("sensitive"));
        let failed_history = failing.room_history("failure-room").unwrap();
        assert!(failed_history.completed_turns.contains(&failed_event.0));
        let _ = fs::remove_dir_all(path);
        let _ = fs::remove_dir_all(failing_path);
    }
    #[tokio::test]
    async fn advisory_room_lock_releases_when_owner_drops() {
        let path = std::env::temp_dir().join(format!("hivemind-lock-{}", stable_id()));
        let first = acquire_file_lock(&path, "room").await.unwrap();
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(30),
            acquire_file_lock(&path, "room")
        )
        .await
        .is_err());
        drop(first);
        let second = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            acquire_file_lock(&path, "room"),
        )
        .await
        .unwrap()
        .unwrap();
        drop(second);
        let _ = fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn broadcast_concurrent_failure_and_canonical_history_persist() {
        let (path, coord) = fixture();
        let f = fake(Some("B"));
        let members = vec![member("A"), member("B")];
        let replies = coord
            .turn(TurnRequest {
                room: "room",
                room_name: "Team",
                group_id: "",
                mode: ConversationMode::Broadcast,
                members: &members,
                input: "question",
                invoker: f.clone(),
            })
            .await
            .unwrap();
        assert!(f.max_running.load(Ordering::SeqCst) > 1);
        assert!(replies[1].result.is_err());
        let history = ConversationCoordinator::new(&path, ContextConfig::default(), coord.memory())
            .room_history("room")
            .unwrap();
        assert_eq!(history.events.len(), 3);
        let failed = history
            .events
            .iter()
            .find(|event| event.speaker == "B")
            .unwrap();
        assert!(failed.error);
        assert_eq!(history.room_id, "room");
        let first = history
            .events
            .iter()
            .find(|event| event.speaker == "A")
            .unwrap();
        assert_eq!(first.agent_instance_id.as_deref(), Some("room/A"));
        let _ = fs::remove_dir_all(path);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn broadcast_context_sections_match_across_personas() {
        let (path, coordinator) = fixture();
        let fake = fake(None);
        let seed_members = [member("A"), member("B")];
        coordinator
            .turn(TurnRequest {
                room: "shared-room",
                room_name: "Shared room",
                group_id: "shared-group",
                mode: ConversationMode::Discussion,
                members: &seed_members,
                input: "Goal: shared target\nseed turn one",
                invoker: fake.clone(),
            })
            .await
            .unwrap();
        coordinator
            .turn(TurnRequest {
                room: "shared-room",
                room_name: "Shared room",
                group_id: "shared-group",
                mode: ConversationMode::Discussion,
                members: &seed_members,
                input: "seed turn two",
                invoker: fake.clone(),
            })
            .await
            .unwrap();

        let mut reviewer = member("A");
        reviewer.role = Some("Reviewer".into());
        let mut builder = member("B");
        builder.role = Some("Builder".into());
        let broadcast_members = [reviewer, builder];
        coordinator
            .turn(TurnRequest {
                room: "shared-room",
                room_name: "Shared room",
                group_id: "shared-group",
                mode: ConversationMode::Broadcast,
                members: &broadcast_members,
                input: "one common question",
                invoker: fake.clone(),
            })
            .await
            .unwrap();

        let prompts = fake.prompts.lock();
        let prompt_a = prompts
            .iter()
            .rev()
            .find(|(instance, _)| instance == "shared-room/A")
            .unwrap()
            .1
            .as_str();
        let prompt_b = prompts
            .iter()
            .rev()
            .find(|(instance, _)| instance == "shared-room/B")
            .unwrap()
            .1
            .as_str();
        fn before<'a>(prompt: &'a str, section: &str, next: &str) -> &'a str {
            prompt
                .split_once(section)
                .unwrap()
                .1
                .split_once(next)
                .unwrap()
                .0
        }
        assert_eq!(
            before(prompt_a, "Participants:\n", "\n\nYou are"),
            before(prompt_b, "Participants:\n", "\n\nYou are")
        );
        assert_eq!(
            before(
                prompt_a,
                "Shared room state:\n",
                "\nOlder conversation summary:"
            ),
            before(
                prompt_b,
                "Shared room state:\n",
                "\nOlder conversation summary:"
            )
        );
        assert_eq!(
            before(
                prompt_a,
                "Older conversation summary:\n",
                "\nRecent conversation:"
            ),
            before(
                prompt_b,
                "Older conversation summary:\n",
                "\nRecent conversation:"
            )
        );
        assert_eq!(
            before(
                prompt_a,
                "Recent conversation:\n",
                "\nCurrent user message:"
            ),
            before(
                prompt_b,
                "Recent conversation:\n",
                "\nCurrent user message:"
            )
        );
        assert_eq!(
            prompt_a
                .split_once("Current user message:\n")
                .unwrap()
                .1
                .trim_end(),
            prompt_b
                .split_once("Current user message:\n")
                .unwrap()
                .1
                .trim_end()
        );
        drop(prompts);
        let _ = fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn discussion_failure_is_recorded_and_next_speaker_gets_compact_marker() {
        let (path, coordinator) = fixture();
        let fake = fake(Some("B"));
        let members = [member("A"), member("B"), member("C")];
        let replies = coordinator
            .turn(TurnRequest {
                room: "failure-room",
                room_name: "Failure room",
                group_id: "failure-group",
                mode: ConversationMode::Discussion,
                members: &members,
                input: "discuss the failure",
                invoker: fake.clone(),
            })
            .await
            .unwrap();
        assert!(replies[1].result.is_err());
        let history = coordinator.room_history("failure-room").unwrap();
        let failed = history
            .events
            .iter()
            .find(|event| event.speaker == "B")
            .unwrap();
        assert!(failed.error);
        assert!(failed.content.contains("fixture failure"));

        let prompts = fake.prompts.lock();
        let prompt_c = prompts
            .iter()
            .find(|(instance, _)| instance == "failure-room/C")
            .unwrap()
            .1
            .as_str();
        assert!(prompt_c.contains("B failed to produce a response for this turn."));
        assert!(!prompt_c.contains("fixture failure"));
        let _ = fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn concurrent_rooms_keep_history_and_runtime_instances_isolated() {
        let (path, coord) = fixture();
        let coord = Arc::new(coord);
        let f = fake_with(None, Some(Arc::new(tokio::sync::Barrier::new(2))));
        let members = vec![member("A")];
        let first_coord = coord.clone();
        let first_members = members.clone();
        let first_invoker = f.clone();
        let one = tokio::spawn(async move {
            first_coord
                .turn(TurnRequest {
                    room: "room/a",
                    room_name: "Team A",
                    group_id: "",
                    mode: ConversationMode::Discussion,
                    members: &first_members,
                    input: "message alpha",
                    invoker: first_invoker,
                })
                .await
        });
        let second_coord = coord.clone();
        let second_invoker = f.clone();
        let two = tokio::spawn(async move {
            second_coord
                .turn(TurnRequest {
                    room: "room_a",
                    room_name: "Team B",
                    group_id: "",
                    mode: ConversationMode::Discussion,
                    members: &members,
                    input: "message beta",
                    invoker: second_invoker,
                })
                .await
        });
        one.await.unwrap().unwrap();
        two.await.unwrap().unwrap();
        assert!(
            f.max_running.load(Ordering::SeqCst) > 1,
            "different rooms should progress concurrently"
        );
        let prompts = f.prompts.lock();
        let alpha = prompts
            .iter()
            .find(|(instance, _)| instance == "room/a/A")
            .unwrap();
        let beta = prompts
            .iter()
            .find(|(instance, _)| instance == "room_a/A")
            .unwrap();
        assert!(alpha.1.contains("message alpha") && !alpha.1.contains("message beta"));
        assert!(beta.1.contains("message beta") && !beta.1.contains("message alpha"));
        drop(prompts);
        assert_eq!(
            coord.room_history("room/a").unwrap().events[0].content,
            "message alpha"
        );
        assert_eq!(
            coord.room_history("room_a").unwrap().events[0].content,
            "message beta"
        );
        let _ = fs::remove_dir_all(path);
    }
    #[tokio::test]
    async fn discussion_context_is_ordered_and_rooms_are_isolated() {
        let (path, coord) = fixture();
        let f = fake(None);
        let members = vec![member("A"), member("B")];
        coord
            .turn(TurnRequest {
                room: "room/a",
                room_name: "Team",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &members,
                input: "question",
                invoker: f.clone(),
            })
            .await
            .unwrap();
        {
            let prompts = f.prompts.lock();
            assert!(prompts[0].1.contains("A role") && prompts[0].1.contains("B role"));
            assert!(!prompts[0].1.contains("A answered"));
            assert!(prompts[1].1.contains("A: A answered"));
        }
        coord
            .turn(TurnRequest {
                room: "room_a",
                room_name: "Other",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &[member("A")],
                input: "second room",
                invoker: f.clone(),
            })
            .await
            .unwrap();
        let isolated = coord.room_history("room_a").unwrap();
        assert_eq!(isolated.events[0].content, "second room");
        let store = JsonFileStore::new(&path);
        assert_ne!(store.room_path("room/a"), store.room_path("room_a"));
        let _ = fs::remove_dir_all(path);
    }
    #[tokio::test]
    async fn interrupted_canonical_turns_are_summarized_before_they_age_out() {
        let (path, coord) = fixture();
        JsonFileStore::new(&path)
            .save_room(
                "room",
                &RoomHistory {
                    room_id: "room".into(),
                    events: vec![
                        MessageEvent {
                            id: "orphan-user".into(),
                            turn_id: "interrupted".into(),
                            speaker: "user".into(),
                            agent_instance_id: None,
                            content: "interrupted user input".into(),
                            error: false,
                        },
                        MessageEvent {
                            id: "orphan-reply".into(),
                            turn_id: "interrupted".into(),
                            speaker: "A".into(),
                            agent_instance_id: Some("room/A".into()),
                            content: "interrupted assistant response".into(),
                            error: false,
                        },
                    ],
                    ..RoomHistory::default()
                },
            )
            .unwrap();
        let f = fake(None);
        let member = [member("A")];
        coord
            .turn(TurnRequest {
                room: "room",
                room_name: "Team",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &member,
                input: "first recovered turn",
                invoker: f.clone(),
            })
            .await
            .unwrap();
        let history = coord.room_history("room").unwrap();
        assert!(history.summary.contains("interrupted user input"));
        assert!(history.summary.contains("interrupted assistant response"));
        assert!(!history.completed_turns.contains(&"interrupted".to_owned()));

        coord
            .turn(TurnRequest {
                room: "room",
                room_name: "Team",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &member,
                input: "second recovered turn",
                invoker: f.clone(),
            })
            .await
            .unwrap();
        let pack = f.prompts.lock().last().unwrap().1.clone();
        assert!(pack.contains("Older conversation summary:"));
        assert!(pack.contains("interrupted assistant response"));
        let _ = fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn state_summary_budget_and_utf8_boundaries_are_preserved() {
        let (path, coord) = fixture();
        let f = fake(None);
        let member = [member("A")];
        coord
            .turn(TurnRequest {
                room: "room",
                room_name: "Team",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &member,
                input: "Goal: Ship safely\nolder one",
                invoker: f.clone(),
            })
            .await
            .unwrap();
        assert_eq!(
            coord.room_history("room").unwrap().state.goal.as_deref(),
            Some("Ship safely")
        );
        coord
            .turn(TurnRequest {
                room: "room",
                room_name: "Team",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &member,
                input: "older two",
                invoker: f.clone(),
            })
            .await
            .unwrap();
        coord
            .turn(TurnRequest {
                room: "room",
                room_name: "Team",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &member,
                input: "current three",
                invoker: f.clone(),
            })
            .await
            .unwrap();
        let last = f.prompts.lock().last().unwrap().1.clone();
        assert!(last.contains("Older conversation summary:") && last.contains("older one"));
        assert!(last.contains("Current user message:\ncurrent three"));
        assert_eq!(utf8_suffix("🌿abcdef", 5), "bcdef");
        coord
            .turn(TurnRequest {
                room: "room",
                room_name: "Team",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &member,
                input: "current four",
                invoker: f.clone(),
            })
            .await
            .unwrap();
        let fourth = f.prompts.lock().last().unwrap().1.clone();
        assert!(fourth.contains("older two"));
        assert!(fourth.contains("current three"));
        assert_eq!(utf8_suffix("🌿abcdef", 5), "bcdef");

        let limits = ContextConfig {
            context_target_tokens: 1000,
            ..ContextConfig::default()
        };
        let bounded = ConversationCoordinator::new(&path, limits, coord.memory());
        let oversized = bounded
            .turn(TurnRequest {
                room: "other",
                room_name: "Team",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &member,
                input: &"x".repeat(5000),
                invoker: f,
            })
            .await
            .unwrap();
        assert!(oversized[0]
            .result
            .as_ref()
            .unwrap_err()
            .contains("exceed configured"));
        assert_eq!(
            bounded.room_history("other").unwrap().events[0].speaker,
            "user"
        );
        let _ = fs::remove_dir_all(path);
    }
    #[tokio::test]
    async fn explicit_state_updates_are_persisted_and_recalled_in_the_next_pack() {
        let (path, coord) = fixture();
        let f = fake(None);
        *f.reply.lock() = Some("Decision: model-generated should be ignored".into());
        let member = [member("A")];
        coord
            .turn(TurnRequest {
                room: "state-room",
                room_name: "Team",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &member,
                input: "Decision: use typed updates\nAssign: A = implement parser",
                invoker: f.clone(),
            })
            .await
            .unwrap();
        coord
            .turn(TurnRequest {
                room: "state-room",
                room_name: "Team",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &member,
                input: "continue",
                invoker: f.clone(),
            })
            .await
            .unwrap();

        let history = coord.room_history("state-room").unwrap();
        assert_eq!(history.state.decisions, ["use typed updates"]);
        assert_eq!(
            history.state.assignments.get("A").map(String::as_str),
            Some("implement parser")
        );
        let next_pack = f.prompts.lock().last().unwrap().1.clone();
        assert!(next_pack.contains(r#""decisions":["use typed updates"]"#));
        assert!(next_pack.contains(r#""assignments":{"A":"implement parser"}"#));
        let _ = fs::remove_dir_all(path);
    }
    #[tokio::test]
    async fn invalid_state_update_keeps_prior_state_and_finalizes_turn() {
        let (path, coord) = fixture();
        let goal = "x".repeat(1900);
        let member = [member("A")];
        let first = coord
            .turn(TurnRequest {
                room: "state-room",
                room_name: "Team",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &member,
                input: &format!("Goal: {goal}"),
                invoker: fake(None),
            })
            .await
            .unwrap();
        assert_eq!(first[0].result.as_deref(), Ok("A answered"));
        let previous_state = coord.room_history("state-room").unwrap().state;
        assert_eq!(previous_state.goal.as_deref(), Some(goal.as_str()));

        let replies = coord
            .turn(TurnRequest {
                room: "state-room",
                room_name: "Team",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &member,
                input: "Decision: this would exceed the serialized state budget",
                invoker: fake(None),
            })
            .await
            .unwrap();
        assert_eq!(replies[0].result.as_deref(), Ok("A answered"));

        let history = coord.room_history("state-room").unwrap();
        assert_eq!(history.state, previous_state);
        assert_eq!(history.completed_turns.len(), 2);
        assert_eq!(history.events.len(), 4);
        assert_eq!(history.events[2].speaker, "user");
        assert_eq!(history.events[3].speaker, "A");
        assert_eq!(history.events[3].content, "A answered");
        assert_eq!(history.maintenance_errors.len(), 1);
        assert!(history.maintenance_errors[0]
            .contains("serialized room state exceeds context budget limit of 2000 bytes"));
        let _ = fs::remove_dir_all(path);
    }
    #[test]
    fn context_budget_trims_old_history_but_keeps_current_input() {
        let path = std::env::temp_dir().join(format!("hivemind-budget-{}", stable_id()));
        let limits = ContextConfig {
            context_target_tokens: 600,
            ..ContextConfig::default()
        };
        let coordinator = ConversationCoordinator::with_store(
            Arc::new(JsonFileStore::new(&path)),
            limits,
            in_memory_memory(),
        );
        let member = member("A");
        let history = RoomHistory {
            summary: "old-summary ".repeat(400),
            events: vec![MessageEvent {
                id: "old".into(),
                turn_id: "old-turn".into(),
                speaker: "user".into(),
                agent_instance_id: None,
                content: "old-message ".repeat(400),
                error: false,
            }],
            ..RoomHistory::default()
        };
        let caller = invocation_caller("room", "", "A", "current-turn", "message-1");
        let request = PackRequest {
            history: &history,
            room_name: "Team",
            members: std::slice::from_ref(&member),
            current: &member,
            input: "retain this current request",
            prior: &[],
            active_turn: "current-turn",
            caller: &caller,
        };
        let state_json = coordinator.state_json(&history, &caller).unwrap();
        let pack = coordinator.context_pack(&request, &state_json).unwrap();
        assert!(pack.len() <= 600 * 4, "manifest must fit the same budget");
        assert!(pack.contains("retain this current request"));
        assert!(pack.contains("Participants:"));
        assert!(pack.contains(ROOM_MEMORY_TOOL_MANIFEST));
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn turn_delta_lists_unseen_peers_and_changed_state_and_rejects_gaps() {
        let path = std::env::temp_dir().join(format!("hivemind-delta-{}", stable_id()));
        let limits = ContextConfig {
            context_target_tokens: 600,
            ..ContextConfig::default()
        };
        let coordinator = ConversationCoordinator::with_store(
            Arc::new(JsonFileStore::new(&path)),
            limits,
            in_memory_memory(),
        );
        let members = [member("A"), member("B")];
        let event = |turn_id: &str, speaker: &str, content: &str| MessageEvent {
            id: stable_id(),
            turn_id: turn_id.into(),
            speaker: speaker.into(),
            agent_instance_id: None,
            content: content.into(),
            error: false,
        };
        let history = RoomHistory {
            events: vec![
                event("t1", "user", "earlier question"),
                event("t1", "A", "earlier answer"),
                event("t1", "B", "peer answer"),
            ],
            ..RoomHistory::default()
        };
        let caller = invocation_caller("room", "", "A", "t2", "message-1");
        let request = PackRequest {
            history: &history,
            room_name: "Team",
            members: &members,
            current: &members[0],
            input: "next question",
            prior: &[],
            active_turn: "t2",
            caller: &caller,
        };
        let state_json = coordinator.state_json(&history, &caller).unwrap();
        let cursor = TurnView {
            turn_id: "t1".into(),
            speakers: vec!["user".into(), "A".into()],
            state_json: "{\"stale\":true}".into(),
        };
        let delta = coordinator
            .turn_delta(&request, &cursor, &state_json)
            .unwrap();
        assert!(
            delta.contains("Room update since your last reply:\nB: peer answer\n"),
            "{delta}"
        );
        assert!(!delta.contains("A: earlier answer"), "{delta}");
        assert!(
            delta.contains(&format!("\nShared room state:\n{state_json}\n")),
            "{delta}"
        );
        assert!(
            delta.contains("\nCurrent user message:\nnext question\n"),
            "{delta}"
        );
        assert!(delta.contains(SESSION_TOOL_REMINDER), "{delta}");

        let unchanged = TurnView {
            state_json: state_json.clone(),
            ..cursor.clone()
        };
        let delta = coordinator
            .turn_delta(&request, &unchanged, &state_json)
            .unwrap();
        assert!(!delta.contains("Shared room state:"), "{delta}");

        let gap = TurnView {
            turn_id: "missing-turn".into(),
            ..cursor.clone()
        };
        assert!(coordinator
            .turn_delta(&request, &gap, &state_json)
            .is_none());

        let oversized = RoomHistory {
            events: vec![
                event("t1", "user", "earlier question"),
                event("t1", "B", &"x".repeat(4000)),
            ],
            ..RoomHistory::default()
        };
        let request = PackRequest {
            history: &oversized,
            ..request
        };
        assert!(coordinator
            .turn_delta(&request, &cursor, &state_json)
            .is_none());
        let _ = fs::remove_dir_all(path);
    }

    // ---- Hivemind memory tool bridge ----

    /// Invoker with a scripted reply sequence; falls back to plain text.
    struct Scripted {
        prompts: Mutex<Vec<String>>,
        replies: Mutex<std::collections::VecDeque<String>>,
    }
    #[async_trait]
    impl AgentInvoker for Scripted {
        async fn cursor(&self, _instance_id: &str) -> Option<SessionCursor> {
            None
        }

        async fn invoke(&self, request: InvokeRequest<'_>) -> Result<InvokeReply> {
            self.prompts.lock().push(request.full.to_owned());
            tokio::task::yield_now().await;
            let text = match self.replies.lock().pop_front() {
                Some(reply) => reply,
                None => "plain final answer".into(),
            };
            Ok(InvokeReply {
                text,
                epoch_id: "fake".into(),
            })
        }
    }
    fn scripted(replies: &[&str]) -> Arc<Scripted> {
        Arc::new(Scripted {
            prompts: Mutex::new(Vec::new()),
            replies: Mutex::new(
                replies
                    .iter()
                    .map(|reply| (*reply).to_owned())
                    .collect::<std::collections::VecDeque<_>>(),
            ),
        })
    }
    fn tool_block(name: &str, args: serde_json::Value) -> String {
        format!(
            "Looking things up.\n```hivemind-tool\n{{\"name\":\"{name}\",\"args\":{args}}}\n```\n"
        )
    }
    fn tool_call(name: &str, args: serde_json::Value) -> MemoryToolCall {
        MemoryToolCall {
            name: name.to_owned(),
            args,
        }
    }

    #[tokio::test]
    async fn tool_loop_executes_actions_reprompts_and_returns_final_text() {
        let (path, coord) = fixture();
        let add = tool_block(
            "memory.private.add",
            serde_json::json!({
                "content": "websocket auth uses JWT",
                "room_id": "spoofed-room",
                "instance": "spoofed-instance",
                "persona": "spoofed-persona"
            }),
        );
        let search = tool_block(
            "memory.search",
            serde_json::json!({"query": "websocket JWT", "scopes": ["private"]}),
        );
        let f = scripted(&[&add, &search]);
        let members = [member("A")];
        let replies = coord
            .turn(TurnRequest {
                room: "tool-room",
                room_name: "Team",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &members,
                input: "check memory",
                invoker: f.clone(),
            })
            .await
            .unwrap();
        assert_eq!(replies[0].result.as_deref(), Ok("plain final answer"));
        assert_eq!(f.prompts.lock().len(), 3, "two actions then final text");
        {
            let prompts = f.prompts.lock();
            assert!(prompts[0].contains("Hivemind memory tools"));
            assert!(prompts[1].contains("Memory tool exchange this turn"));
            assert!(prompts[1].contains("stored private memory"));
            assert!(prompts[2].contains("1 memory results:"));
            assert!(prompts[2].contains("[private] websocket auth uses JWT"));
        }
        // Spoofed owner fields in args were ignored: the record is bound to
        // the invocation instance Hivemind created.
        let caller = Caller::agent("tool-room", "", "tool-room/A", "A", "A");
        let found = coord
            .memory()
            .store()
            .records_in_scope(&caller, &Scope::AgentInstance("tool-room/A".into()))
            .unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].content.contains("websocket auth uses JWT"));
        let other = Caller::agent("tool-room", "", "tool-room/B", "B", "B");
        assert!(coord
            .memory()
            .store()
            .records_in_scope(&other, &Scope::AgentInstance("tool-room/A".into()))
            .is_err());
        let _ = fs::remove_dir_all(path);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn tool_loop_enforces_action_cap_before_plain_text() {
        let (path, coord) = fixture();
        let block = tool_block(
            "memory.private.add",
            serde_json::json!({"content": "bounded note"}),
        );
        let f = scripted(&[&block, &block, &block, &block, &block]);
        let members = [member("A")];
        let replies = coord
            .turn(TurnRequest {
                room: "cap-room",
                room_name: "Team",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &members,
                input: "keep calling",
                invoker: f.clone(),
            })
            .await
            .unwrap();
        let error = replies[0].result.as_ref().unwrap_err();
        assert!(error.contains("memory tool action limit (4)"), "{error}");
        assert_eq!(f.prompts.lock().len(), 5, "four actions then the cap");
        let _ = fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn malformed_tool_blocks_are_fed_back_not_guessed() {
        let (path, coord) = fixture();
        let broken = "```hivemind-tool\n{\"name\":\n```";
        let f = scripted(&[broken]);
        let members = [member("A")];
        let replies = coord
            .turn(TurnRequest {
                room: "malformed-room",
                room_name: "Team",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &members,
                input: "go",
                invoker: f.clone(),
            })
            .await
            .unwrap();
        // The parse failure is feedback, so the loop re-prompts; the scripted
        // invoker then falls back to plain text.
        assert_eq!(replies[0].result.as_deref(), Ok("plain final answer"));
        assert_eq!(f.prompts.lock().len(), 2);
        assert!(f.prompts.lock()[1].contains("error: hivemind-tool block is not valid JSON"));
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn tool_execution_denies_cross_scope_reads_and_unauthorized_group_writes() {
        let memory = MemoryService::new(MemoryStore::in_memory().unwrap());
        let alice = invocation_caller("room-1", "grp-1", "room-1/Alice", "turn-1", "msg-1");
        let bob = invocation_caller("room-2", "grp-2", "room-2/Bob", "turn-1", "msg-1");

        execute_memory_tool(
            &memory,
            &alice,
            &tool_call(
                "memory.private.add",
                serde_json::json!({"content": "alice private note"}),
            ),
        )
        .unwrap();
        let denied = execute_memory_tool(
            &memory,
            &bob,
            &tool_call(
                "memory.search",
                serde_json::json!({"query": "alice private", "scopes": ["private"]}),
            ),
        )
        .unwrap();
        assert_eq!(denied, "no memory results matched");

        execute_memory_tool(
            &memory,
            &alice,
            &tool_call(
                "memory.group.add",
                serde_json::json!({"content": "grp-1 shared decision"}),
            ),
        )
        .unwrap();
        let cross_group = execute_memory_tool(
            &memory,
            &bob,
            &tool_call(
                "memory.search",
                serde_json::json!({"query": "shared decision", "scopes": ["group"]}),
            ),
        )
        .unwrap();
        assert_eq!(cross_group, "no memory results matched");

        // A route with no configured group has no group scope at all.
        let solo = invocation_caller("solo-room", "", "solo-room/S", "turn-1", "msg-1");
        let group_error = execute_memory_tool(
            &memory,
            &solo,
            &tool_call(
                "memory.group.add",
                serde_json::json!({"content": "no group here"}),
            ),
        )
        .unwrap_err()
        .to_string();
        assert!(group_error.contains("group"), "{group_error}");
        // ...but private writes still work for that caller.
        execute_memory_tool(
            &memory,
            &solo,
            &tool_call(
                "memory.private.add",
                serde_json::json!({"content": "solo private note"}),
            ),
        )
        .unwrap();
    }

    #[test]
    fn proposals_are_policy_gated_and_archive_respects_trust() {
        let memory = MemoryService::new(MemoryStore::in_memory().unwrap());
        let caller = invocation_caller("room-1", "grp-1", "room-1/A", "turn-1", "msg-1");

        let persona = execute_memory_tool(
            &memory,
            &caller,
            &tool_call(
                "memory.persona.propose",
                serde_json::json!({"content": "Maomao prefers small service boundaries"}),
            ),
        )
        .unwrap();
        assert!(persona.starts_with("accepted persona memory"), "{persona}");

        let global_error = execute_memory_tool(
            &memory,
            &caller,
            &tool_call(
                "memory.global.propose",
                serde_json::json!({"content": "Hivemind architecture is final"}),
            ),
        )
        .unwrap_err()
        .to_string();
        assert!(
            global_error.contains("deterministic source"),
            "{global_error}"
        );

        let private = execute_memory_tool(
            &memory,
            &caller,
            &tool_call(
                "memory.private.add",
                serde_json::json!({"content": "archivable note"}),
            ),
        )
        .unwrap();
        let private_id = private
            .split_whitespace()
            .last()
            .expect("result names the id")
            .to_owned();
        execute_memory_tool(
            &memory,
            &caller,
            &tool_call("memory.archive", serde_json::json!({"id": private_id})),
        )
        .unwrap();

        let persona_id = persona
            .split_whitespace()
            .nth(3)
            .expect("result names the id")
            .to_owned();
        let archive_error = execute_memory_tool(
            &memory,
            &caller,
            &tool_call("memory.archive", serde_json::json!({"id": persona_id})),
        )
        .unwrap_err()
        .to_string();
        assert!(archive_error.contains("trusted caller"), "{archive_error}");
    }

    #[test]
    fn unknown_tool_and_unknown_scope_are_rejected() {
        let memory = MemoryService::new(MemoryStore::in_memory().unwrap());
        let caller = invocation_caller("room-1", "grp-1", "room-1/A", "turn-1", "msg-1");
        let unknown = execute_memory_tool(
            &memory,
            &caller,
            &tool_call("memory.drop_everything", serde_json::json!({})),
        )
        .unwrap_err()
        .to_string();
        assert!(unknown.contains("unknown memory tool"));
        let bad_scope = execute_memory_tool(
            &memory,
            &caller,
            &tool_call(
                "memory.search",
                serde_json::json!({"query": "x", "scopes": ["other-group-id"]}),
            ),
        )
        .unwrap_err()
        .to_string();
        assert!(bad_scope.contains("unknown search scope"));
    }

    #[tokio::test]
    async fn context_pack_injects_authorized_hits_and_never_echoes_current_input() {
        let (path, coord) = fixture();
        let seeder = invocation_caller("seed-room", "grp", "S", "seed-turn", "seed-msg");
        coord
            .memory()
            .add_group(
                &seeder,
                MemoryWrite {
                    id: None,
                    kind: "note".into(),
                    content: "Authentication strategy is undecided".into(),
                    provenance: Provenance::default(),
                    importance: 40,
                    supersedes_memory_id: None,
                },
            )
            .unwrap();
        let f = fake(None);
        let members = [member("A")];

        coord
            .turn(TurnRequest {
                room: "grp-room",
                room_name: "Team",
                group_id: "grp",
                mode: ConversationMode::Discussion,
                members: &members,
                input: "authentication strategy?",
                invoker: f.clone(),
            })
            .await
            .unwrap();
        coord
            .turn(TurnRequest {
                room: "fresh-room",
                room_name: "Team",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &members,
                input: "unique xylophone question",
                invoker: f.clone(),
            })
            .await
            .unwrap();
        coord
            .turn(TurnRequest {
                room: "other-room",
                room_name: "Team",
                group_id: "grp-2",
                mode: ConversationMode::Discussion,
                members: &members,
                input: "authentication strategy",
                invoker: f.clone(),
            })
            .await
            .unwrap();
        {
            let prompts = f.prompts.lock();
            assert!(prompts[0].1.contains("Relevant Hivemind memory:"));
            assert!(prompts[0]
                .1
                .contains("[group] Authentication strategy is undecided"));
            assert!(prompts[0]
                .1
                .contains("(source: room seed-room, turn seed-turn, message seed-msg, actor S)"));
            assert!(prompts[0].1.contains(GROUP_MEMORY_TOOL_MANIFEST));
            // Current-turn input is never echoed back as a memory hit.
            assert!(!prompts[1].1.contains("Relevant Hivemind memory:"));
            // Groupless rooms never advertise group tools.
            assert!(prompts[1].1.contains(ROOM_MEMORY_TOOL_MANIFEST));
            assert!(!prompts[1].1.contains("memory.group."));
            // Another group never sees grp's shared memory.
            assert!(!prompts[2].1.contains("Relevant Hivemind memory:"));
            assert!(prompts[2].1.contains(GROUP_MEMORY_TOOL_MANIFEST));
        }
        let _ = fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn fresh_agents_all_receive_the_same_hivemind_generated_manifest() {
        let (path, coord) = fixture();
        let f = fake(None);
        let members = [member("A"), member("B")];
        coord
            .turn(TurnRequest {
                room: "guidance-room",
                room_name: "Team",
                group_id: "",
                mode: ConversationMode::Broadcast,
                members: &members,
                input: "hello",
                invoker: f.clone(),
            })
            .await
            .unwrap();
        {
            let prompts = f.prompts.lock();
            assert!(prompts
                .iter()
                .any(|(instance, _)| instance == "guidance-room/A"));
            assert!(prompts
                .iter()
                .any(|(instance, _)| instance == "guidance-room/B"));
            for (_, prompt) in prompts.iter() {
                assert!(prompt.contains(ROOM_MEMORY_TOOL_MANIFEST));
                assert!(prompt.contains("memory.persona.propose"));
            }
            // Both manifests are Hivemind-generated constants, not persona prose.
            assert!(!ROOM_MEMORY_TOOL_MANIFEST.contains("You are "));
            assert!(!GROUP_MEMORY_TOOL_MANIFEST.contains("You are "));
        }
        let _ = fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn legacy_json_history_migrates_once_into_sqlite_and_json_is_removed() {
        let (path, coord) = fixture();
        let json_path = JsonFileStore::new(&path).room_path("legacy-room");
        JsonFileStore::new(&path)
            .save_room(
                "legacy-room",
                &RoomHistory {
                    room_id: "legacy-room".into(),
                    events: vec![
                        MessageEvent {
                            id: "old-user".into(),
                            turn_id: "old-turn".into(),
                            speaker: "user".into(),
                            agent_instance_id: None,
                            content: "legacy question".into(),
                            error: false,
                        },
                        MessageEvent {
                            id: "old-reply".into(),
                            turn_id: "old-turn".into(),
                            speaker: "A".into(),
                            agent_instance_id: Some("legacy-room/A".into()),
                            content: "legacy answer".into(),
                            error: true,
                        },
                    ],
                    summary: "legacy summary".into(),
                    completed_turns: vec!["old-turn".into()],
                    ..RoomHistory::default()
                },
            )
            .unwrap();
        assert!(json_path.exists());

        let history = coord.room_history("legacy-room").unwrap();
        assert_eq!(history.events.len(), 2);
        assert_eq!(history.events[0].content, "legacy question");
        assert!(history.events[1].error);
        assert_eq!(
            history.completed_turns,
            [legacy_turn_id("legacy-room", "old-turn")]
        );
        assert_eq!(history.summary, "legacy summary");
        assert!(!json_path.exists(), "migrated JSON must be removed");

        // The migrated history survives in SQLite after the JSON is gone.
        let again = coord.room_history("legacy-room").unwrap();
        assert_eq!(again.events.len(), 2);
        let _ = fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn partial_legacy_import_resumes_without_loss_or_duplicates() {
        let (path, coord) = fixture();
        let room = "legacy-resume";
        let json_store = JsonFileStore::new(&path);
        json_store
            .save_room(
                room,
                &RoomHistory {
                    room_id: room.into(),
                    events: vec![
                        MessageEvent {
                            id: "e1".into(),
                            turn_id: "t1".into(),
                            speaker: "user".into(),
                            agent_instance_id: None,
                            content: "first question".into(),
                            error: false,
                        },
                        MessageEvent {
                            id: "e2".into(),
                            turn_id: "t1".into(),
                            speaker: "A".into(),
                            agent_instance_id: Some(format!("{room}/A")),
                            content: "first answer".into(),
                            error: false,
                        },
                        MessageEvent {
                            id: "e3".into(),
                            turn_id: "t2".into(),
                            speaker: "user".into(),
                            agent_instance_id: None,
                            content: "second question".into(),
                            error: false,
                        },
                        MessageEvent {
                            id: "e4".into(),
                            turn_id: "t2".into(),
                            speaker: "A".into(),
                            agent_instance_id: Some(format!("{room}/A")),
                            content: "second answer".into(),
                            error: true,
                        },
                    ],
                    completed_turns: vec!["t1".into(), "t2".into()],
                    summary: "resumed summary".into(),
                    ..RoomHistory::default()
                },
            )
            .unwrap();
        let json_path = json_store.room_path(room);
        assert!(json_path.exists());

        // Simulate a crashed first attempt: only the first legacy turn was
        // written, using exactly the stable ids import_legacy computes. The
        // archive is now non-empty, so inferring completion from any single
        // message would skip the import and delete the unimported turns.
        let partial_messages: Vec<ArchivedMessage> = [
            (0usize, "e1", "user", "first question"),
            (1, "e2", "A", "first answer"),
        ]
        .into_iter()
        .map(|(index, id, speaker, content)| ArchivedMessage {
            id: legacy_message_id(room, index, id),
            room_id: room.into(),
            turn_id: legacy_turn_id(room, "t1"),
            speaker: speaker.into(),
            content: content.into(),
            created_at: 0,
        })
        .collect();
        coord
            .memory()
            .append_archive_turn(
                &Caller::trusted_user("test"),
                ArchivedTurn {
                    id: legacy_turn_id(room, "t1"),
                    room_id: room.into(),
                    started_at: 1,
                    completed_at: Some(2),
                    metadata: serde_json::Value::Null,
                    participants: vec![ArchiveParticipant {
                        participant_id: "A".into(),
                        role: None,
                    }],
                    messages: partial_messages,
                },
            )
            .unwrap();
        assert!(
            !coord
                .memory()
                .recent_messages(&Caller::trusted_user("test"), room, 10)
                .unwrap()
                .is_empty(),
            "preexisting partial archive must exist"
        );

        let history = coord.room_history(room).unwrap();
        assert_eq!(
            history.events.len(),
            4,
            "every legacy turn must survive a resumed import"
        );
        assert_eq!(history.events[0].content, "first question");
        assert_eq!(history.events[1].content, "first answer");
        assert_eq!(history.events[2].content, "second question");
        assert_eq!(history.events[3].content, "second answer");
        assert!(history.events[3].error);
        let mut ids: Vec<String> = history.events.iter().map(|e| e.id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 4, "resumed import must not duplicate ids");
        assert_eq!(
            history.completed_turns,
            [legacy_turn_id(room, "t1"), legacy_turn_id(room, "t2")]
        );
        assert_eq!(history.summary, "resumed summary");
        assert!(!json_path.exists(), "file removed only after full success");

        // Idempotent after removal: a reload still returns the full history.
        assert_eq!(coord.room_history(room).unwrap().events.len(), 4);
        let _ = fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn group_state_persists_across_coordinator_and_store_restarts() {
        let root = std::env::temp_dir().join(format!("hivemind-group-state-{}", stable_id()));
        fs::create_dir_all(&root).unwrap();
        let database = root.join("memory.sqlite3");
        let context = root.join("context");
        let limits = ContextConfig {
            recent_turns: 2,
            summary_max_tokens: 100,
            context_target_tokens: 1000,
            runtime_rotate_tokens: 24000,
            summary_refresh_turns: 2,
        };
        let caller = || Caller::agent("gs-room", "gs-group", "gs-room/A", "A", "A");
        {
            let memory = Arc::new(MemoryService::open(&database).unwrap());
            let coord = ConversationCoordinator::new(&context, limits.clone(), memory);
            let members = [member("A")];
            coord
                .turn(TurnRequest {
                    room: "gs-room",
                    room_name: "Team",
                    group_id: "gs-group",
                    mode: ConversationMode::Discussion,
                    members: &members,
                    input: "Decision: use JWT tokens",
                    invoker: fake(None),
                })
                .await
                .unwrap();
            let stored = coord
                .memory()
                .group_state(&caller())
                .unwrap()
                .expect("accepted group directive must persist as canonical group state");
            assert!(stored.state.to_string().contains("use JWT tokens"));
        }

        // Fresh coordinator + fresh store connection: group state survives.
        let memory = Arc::new(MemoryService::open(&database).unwrap());
        let coord = ConversationCoordinator::new(&context, limits, memory);
        let stored = coord
            .memory()
            .group_state(&caller())
            .unwrap()
            .expect("group state must survive a store restart");
        assert!(stored.state.to_string().contains("use JWT tokens"));
        let members = [member("A")];
        let f = fake(None);
        coord
            .turn(TurnRequest {
                room: "gs-room",
                room_name: "Team",
                group_id: "gs-group",
                mode: ConversationMode::Discussion,
                members: &members,
                input: "anything",
                invoker: f.clone(),
            })
            .await
            .unwrap();
        let prompts = f.prompts.lock();
        assert!(
            prompts[0].1.contains("Shared room state:"),
            "restarted group caller must load canonical group state into context"
        );
        assert!(prompts[0].1.contains("use JWT tokens"));
        drop(prompts);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn assignment_directive_becomes_a_private_note_for_the_assignee_only() {
        let (path, coord) = fixture();
        let members = [member("A"), member("B")];
        coord
            .turn(TurnRequest {
                room: "assign-room",
                room_name: "Team",
                group_id: "assign-group",
                mode: ConversationMode::Discussion,
                members: &members,
                input: "Assign: B = write docs",
                invoker: fake(None),
            })
            .await
            .unwrap();

        let assignee = Caller::agent("assign-room", "assign-group", "assign-room/B", "B", "B");
        let notes = coord
            .memory()
            .store()
            .records_in_scope(&assignee, &Scope::AgentInstance("assign-room/B".into()))
            .unwrap();
        assert!(
            notes.iter().any(|record| record.kind == "assignment"
                && record.content.contains("Assigned: write docs")),
            "assignee must hold the private L4 assignment note, got {:?}",
            notes
                .iter()
                .map(|r| (&r.kind, &r.content))
                .collect::<Vec<_>>()
        );

        let other = Caller::agent("assign-room", "assign-group", "assign-room/A", "A", "A");
        let others_notes = coord
            .memory()
            .store()
            .records_in_scope(&other, &Scope::AgentInstance("assign-room/A".into()))
            .unwrap();
        assert!(
            others_notes.is_empty(),
            "assignment must stay private to the assignee: {:?}",
            others_notes
                .iter()
                .map(|r| (&r.kind, &r.content))
                .collect::<Vec<_>>()
        );

        // The group's shared state still records the assignment mapping and
        // attributes the directive's author (the user), not a persona.
        let group = coord
            .memory()
            .group_state(&other)
            .unwrap()
            .expect("group state recorded");
        assert!(group.state.to_string().contains("write docs"));
        assert_eq!(group.updated_by, "user");

        // Reassigning updates the one active note instead of accumulating.
        coord
            .turn(TurnRequest {
                room: "assign-room",
                room_name: "Team",
                group_id: "assign-group",
                mode: ConversationMode::Discussion,
                members: &members,
                input: "Assign: B = write release notes",
                invoker: fake(None),
            })
            .await
            .unwrap();
        let after = coord
            .memory()
            .store()
            .records_in_scope(&assignee, &Scope::AgentInstance("assign-room/B".into()))
            .unwrap();
        let active: Vec<_> = after
            .iter()
            .filter(|record| record.kind == "assignment" && record.status == MemoryStatus::Active)
            .collect();
        assert_eq!(active.len(), 1, "exactly one active assignment note");
        assert!(active[0].content.contains("Assigned: write release notes"));
        assert_eq!(active[0].provenance.source_actor.as_deref(), Some("user"));
        assert_eq!(
            active[0].provenance.source_kind.as_deref(),
            Some("structured_project_event")
        );

        // The old assignment text must not remain searchable as active. Query
        // its distinctive term only: partial matches now retrieve on any token.
        let stale = coord
            .memory()
            .search(
                &assignee,
                &SearchRequest {
                    query: "docs".into(),
                    scopes: vec![SearchScope::Instance],
                    limit: 8,
                    include_historical: false,
                },
            )
            .unwrap();
        assert!(
            stale.is_empty(),
            "old assignment text must not be active: {:?}",
            stale.iter().map(|r| &r.record.content).collect::<Vec<_>>()
        );
        assert!(
            after
                .iter()
                .all(|record| !record.content.contains("write docs")),
            "old assignment text must not remain stored: {:?}",
            after.iter().map(|r| &r.content).collect::<Vec<_>>()
        );
        let fresh = coord
            .memory()
            .search(
                &assignee,
                &SearchRequest {
                    query: "release notes".into(),
                    scopes: vec![SearchScope::Instance],
                    limit: 8,
                    include_historical: false,
                },
            )
            .unwrap();
        assert_eq!(fresh.len(), 1, "current assignment text is searchable");
        let _ = fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn global_proposal_requires_exact_user_directive_binding() {
        let (path, coord) = fixture();
        let coord = Arc::new(coord);
        let members = [member("A")];
        let exact = "Hivemind runtimes are disposable";
        let turn = |input: &str, invoker: Arc<Scripted>| {
            let members = members.clone();
            let input = input.to_owned();
            let coord = coord.clone();
            async move {
                coord
                    .turn(TurnRequest {
                        room: "glob-room",
                        room_name: "Team",
                        group_id: "g-g",
                        mode: ConversationMode::Discussion,
                        members: &members,
                        input: &input,
                        invoker,
                    })
                    .await
            }
        };

        // Valid: the model proposes exactly the user-authorized content.
        let propose = tool_block(
            "memory.global.propose",
            serde_json::json!({ "content": exact }),
        );
        let f = scripted(&[&propose]);
        turn("Global: Hivemind runtimes are disposable", f.clone())
            .await
            .unwrap();
        {
            let prompts = f.prompts.lock();
            assert!(
                prompts[1].contains("accepted global memory"),
                "exact user-authorized proposal must be accepted: {}",
                prompts[1]
            );
        }
        let reader = Caller::agent("glob-room", "g-g", "glob-room/A", "A", "A");
        let globals = coord
            .memory()
            .store()
            .records_in_scope(&reader, &Scope::Hivemind)
            .unwrap();
        assert!(globals.iter().any(|record| record.content.trim() == exact));

        // Mismatched: the directive binds only its exact text.
        let wrong = tool_block(
            "memory.global.propose",
            serde_json::json!({ "content": "Hivemind architecture is final" }),
        );
        let f2 = scripted(&[&wrong]);
        turn("Global: something else entirely", f2.clone())
            .await
            .unwrap();
        {
            let prompts = f2.prompts.lock();
            assert!(
                prompts[1].contains("error:"),
                "mismatched content must be rejected: {}",
                prompts[1]
            );
        }
        let globals = coord
            .memory()
            .store()
            .records_in_scope(&reader, &Scope::Hivemind)
            .unwrap();
        assert_eq!(globals.len(), 1, "mismatch must not create a record");
        assert!(!globals
            .iter()
            .any(|record| record.content.contains("architecture is final")));

        // Unbound: no directive at all can never authorize a global write.
        let f3 = scripted(&[&wrong]);
        turn("plain turn without any directive", f3.clone())
            .await
            .unwrap();
        {
            let prompts = f3.prompts.lock();
            assert!(
                prompts[1].contains("error:"),
                "unbound proposal must be rejected: {}",
                prompts[1]
            );
        }
        let globals = coord
            .memory()
            .store()
            .records_in_scope(&reader, &Scope::Hivemind)
            .unwrap();
        assert_eq!(
            globals.len(),
            1,
            "unbound proposal must not create a record"
        );
        let _ = fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn room_history_round_trips_through_the_sqlite_file_on_disk() {
        let root = std::env::temp_dir().join(format!("hivemind-sqlite-{}", stable_id()));
        fs::create_dir_all(&root).unwrap();
        let database = root.join("memory.sqlite3");
        let context = root.join("context");
        let limits = ContextConfig {
            recent_turns: 2,
            summary_max_tokens: 100,
            context_target_tokens: 1000,
            runtime_rotate_tokens: 24000,
            summary_refresh_turns: 2,
        };
        {
            let memory = Arc::new(MemoryService::open(&database).unwrap());
            let coord = ConversationCoordinator::new(&context, limits.clone(), memory);
            let f = fake(None);
            let members = [member("A")];
            coord
                .turn(TurnRequest {
                    room: "persist-room",
                    room_name: "Team",
                    group_id: "",
                    mode: ConversationMode::Discussion,
                    members: &members,
                    input: "remember me",
                    invoker: f,
                })
                .await
                .unwrap();
        }
        // Fresh connection, fresh coordinator: only SQLite remains.
        let reopened = Arc::new(MemoryService::open(&database).unwrap());
        let coord = ConversationCoordinator::new(&context, limits, reopened);
        let history = coord.room_history("persist-room").unwrap();
        assert_eq!(history.events.len(), 2);
        assert_eq!(history.events[0].content, "remember me");
        assert_eq!(history.events[1].content, "A answered");
        assert_eq!(history.completed_turns.len(), 1);
        let _ = fs::remove_dir_all(root);
    }
}
