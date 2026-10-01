use crate::db::{Result, Session};

pub(super) const V1: &str = r#"
CREATE TABLE IF NOT EXISTS memories (
  id VARCHAR(255) PRIMARY KEY,
  layer VARCHAR(64) NOT NULL,
  scope_type VARCHAR(64) NOT NULL,
  scope_id VARCHAR(255) NOT NULL,
  kind VARCHAR(100) NOT NULL,
  content TEXT NOT NULL,
  source_room_id VARCHAR(255),
  source_turn_id VARCHAR(255),
  source_message_id VARCHAR(255),
  source_actor VARCHAR(255),
  source_kind VARCHAR(100),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  status VARCHAR(16) NOT NULL CHECK(status IN ('active','superseded','archived')),
  importance SMALLINT NOT NULL CHECK(importance BETWEEN 0 AND 100),
  supersedes_memory_id VARCHAR(255),
  topic_key VARCHAR(100),
  search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content || ' ' || kind)) STORED,
  FOREIGN KEY(supersedes_memory_id) REFERENCES memories(id)
);
CREATE INDEX IF NOT EXISTS memories_scope_status ON memories(scope_type, scope_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS memories_active_topic_key ON memories(scope_type,scope_id,topic_key) WHERE status='active' AND topic_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS memories_search_vector ON memories USING GIN(search_vector);
CREATE TABLE IF NOT EXISTS rooms (
  id VARCHAR(255) PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS archive_turns (
  id VARCHAR(255) PRIMARY KEY,
  seq BIGSERIAL UNIQUE NOT NULL,
  room_id VARCHAR(255) NOT NULL REFERENCES rooms(id),
  started_at BIGINT NOT NULL,
  completed_at BIGINT,
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS archive_turns_room ON archive_turns(room_id);
CREATE TABLE IF NOT EXISTS archive_participants (
  turn_id VARCHAR(255) NOT NULL REFERENCES archive_turns(id) ON DELETE CASCADE,
  participant_id VARCHAR(255) NOT NULL,
  role TEXT,
  PRIMARY KEY(turn_id, participant_id)
);
CREATE TABLE IF NOT EXISTS archive_messages (
  id VARCHAR(255) PRIMARY KEY,
  room_id VARCHAR(255) NOT NULL REFERENCES rooms(id),
  turn_id VARCHAR(255) NOT NULL REFERENCES archive_turns(id),
  speaker VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', speaker || ' ' || content)) STORED
);
CREATE INDEX IF NOT EXISTS archive_messages_turn ON archive_messages(turn_id);
CREATE INDEX IF NOT EXISTS archive_room_created_id ON archive_messages(room_id, created_at, id);
CREATE INDEX IF NOT EXISTS archive_messages_search_vector ON archive_messages USING GIN(search_vector);
CREATE TABLE IF NOT EXISTS group_state (
  group_id VARCHAR(255) PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  updated_by VARCHAR(255) NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_epochs (
  id VARCHAR(255) PRIMARY KEY,
  room_id VARCHAR(255) NOT NULL REFERENCES rooms(id),
  instance_id VARCHAR(255) NOT NULL,
  identity_version INTEGER NOT NULL DEFAULT 0,
  runtime VARCHAR(100) NOT NULL,
  started_at BIGINT NOT NULL,
  ended_at BIGINT,
  metadata_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runtime_epochs_identity_start ON runtime_epochs(identity_version,instance_id,started_at DESC);
CREATE TABLE IF NOT EXISTS memory_revisions (
  revision_id VARCHAR(255) PRIMARY KEY,
  memory_id VARCHAR(255) NOT NULL REFERENCES memories(id),
  content TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  actor VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS memory_revisions_memory ON memory_revisions(memory_id, created_at);
"#;

pub(super) fn finish(_session: &Session<'_>) -> Result<()> {
    // PostgreSQL maintains the generated tsvector columns and GIN indexes itself.
    Ok(())
}
