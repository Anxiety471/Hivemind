use crate::db::{Result, Session};

/// InnoDB FULLTEXT uses `innodb_ft_min_token_size` (three characters by default)
/// and its configured stopword list. Short terms and stopwords may therefore
/// be absent from the full-text index even though SQLite/PostgreSQL find them;
/// the search path supplements short terms with bounded `LIKE` candidates.
pub(super) const V1: &str = r#"
CREATE TABLE IF NOT EXISTS memories (
  id VARCHAR(255) NOT NULL,
  layer VARCHAR(64) NOT NULL,
  scope_type VARCHAR(64) NOT NULL,
  scope_id VARCHAR(255) NOT NULL,
  kind VARCHAR(100) NOT NULL,
  content MEDIUMTEXT NOT NULL,
  source_room_id VARCHAR(255),
  source_turn_id VARCHAR(255),
  source_message_id VARCHAR(255),
  source_actor VARCHAR(255),
  source_kind VARCHAR(100),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  status VARCHAR(16) NOT NULL,
  importance SMALLINT NOT NULL,
  supersedes_memory_id VARCHAR(255),
  topic_key VARCHAR(100),
  active_topic_key VARCHAR(100) GENERATED ALWAYS AS (CASE WHEN status='active' THEN topic_key ELSE NULL END) STORED,
  PRIMARY KEY(id),
  KEY memories_scope_status(scope_type,scope_id,status),
  UNIQUE KEY memories_active_topic_key(scope_type,scope_id,active_topic_key),
  FULLTEXT KEY memories_search(content,kind),
  CONSTRAINT memories_supersedes_fk FOREIGN KEY(supersedes_memory_id) REFERENCES memories(id),
  CONSTRAINT memories_status_check CHECK(status IN ('active','superseded','archived')),
  CONSTRAINT memories_importance_check CHECK(importance BETWEEN 0 AND 100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS rooms (
  id VARCHAR(255) NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  updated_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS archive_turns (
  id VARCHAR(255) NOT NULL PRIMARY KEY,
  seq BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
  room_id VARCHAR(255) NOT NULL,
  started_at BIGINT NOT NULL,
  completed_at BIGINT,
  metadata TEXT NOT NULL,
  KEY archive_turns_room(room_id),
  CONSTRAINT archive_turns_room_fk FOREIGN KEY(room_id) REFERENCES rooms(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS archive_participants (
  turn_id VARCHAR(255) NOT NULL,
  participant_id VARCHAR(255) NOT NULL,
  role TEXT,
  PRIMARY KEY(turn_id,participant_id),
  CONSTRAINT archive_participants_turn_fk FOREIGN KEY(turn_id) REFERENCES archive_turns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS archive_messages (
  id VARCHAR(255) NOT NULL PRIMARY KEY,
  room_id VARCHAR(255) NOT NULL,
  turn_id VARCHAR(255) NOT NULL,
  speaker VARCHAR(255) NOT NULL,
  content MEDIUMTEXT NOT NULL,
  created_at BIGINT NOT NULL,
  KEY archive_messages_turn(turn_id),
  KEY archive_room_created_id(room_id,created_at,id),
  FULLTEXT KEY archive_messages_search(speaker,content),
  CONSTRAINT archive_messages_room_fk FOREIGN KEY(room_id) REFERENCES rooms(id),
  CONSTRAINT archive_messages_turn_fk FOREIGN KEY(turn_id) REFERENCES archive_turns(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS group_state (
  group_id VARCHAR(255) NOT NULL PRIMARY KEY,
  state_json LONGTEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  updated_by VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS runtime_epochs (
  id VARCHAR(255) NOT NULL PRIMARY KEY,
  room_id VARCHAR(255) NOT NULL,
  instance_id VARCHAR(255) NOT NULL,
  identity_version INTEGER NOT NULL DEFAULT 0,
  runtime VARCHAR(100) NOT NULL,
  started_at BIGINT NOT NULL,
  ended_at BIGINT,
  metadata_json TEXT NOT NULL,
  KEY runtime_epochs_identity_start(identity_version,instance_id,started_at),
  CONSTRAINT runtime_epochs_room_fk FOREIGN KEY(room_id) REFERENCES rooms(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS memory_revisions (
  revision_id VARCHAR(255) NOT NULL PRIMARY KEY,
  memory_id VARCHAR(255) NOT NULL,
  content MEDIUMTEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  actor VARCHAR(255),
  KEY memory_revisions_memory(memory_id,created_at),
  CONSTRAINT memory_revisions_memory_fk FOREIGN KEY(memory_id) REFERENCES memories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
"#;

pub(super) fn finish(_session: &Session<'_>) -> Result<()> {
    // InnoDB updates FULLTEXT indexes as base rows change.
    Ok(())
}
