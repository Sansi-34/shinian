-- 经验笔记：复用 captures 作为实体（稳定 ID、念头关联、图谱、删除/导出链路），
-- 额外字段放在 experience_notes；依据记录放 experience_sources；引用经验的尝试放 experience_attempts。
ALTER TABLE captures ADD COLUMN kind TEXT NOT NULL DEFAULT 'thought';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS captures_kind_created_idx ON captures (kind, created_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS experience_notes (
  capture_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  understanding_origin TEXT NOT NULL DEFAULT 'model_draft',
  model_basis TEXT,
  origin_kind TEXT NOT NULL DEFAULT 'manual',
  origin_query_id TEXT,
  origin_point_index INTEGER,
  origin_attempt_id TEXT,
  context_capture_id TEXT,
  conditions_text TEXT,
  limitations_text TEXT,
  needs_revision INTEGER NOT NULL DEFAULT 0,
  revision_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS experience_notes_updated_idx ON experience_notes (updated_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS experience_sources (
  id TEXT PRIMARY KEY,
  experience_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_capture_id TEXT,
  source_title TEXT NOT NULL,
  source_text TEXT NOT NULL DEFAULT '',
  source_result_text TEXT,
  outcome TEXT,
  state TEXT,
  observed_at INTEGER,
  source_revision INTEGER NOT NULL,
  source_capture_revision INTEGER,
  source_kind TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS experience_sources_unique ON experience_sources (experience_id, source_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS experience_sources_key_idx ON experience_sources (source_key);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS experience_attempts (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,
  experience_capture_id TEXT NOT NULL,
  adopted_version INTEGER NOT NULL,
  adopted_title TEXT NOT NULL,
  adopted_understanding TEXT NOT NULL,
  basis_source_keys_json TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS experience_attempts_experience_idx ON experience_attempts (experience_capture_id);
