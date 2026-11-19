-- 研究一下（GitHub 开源项目调研）：研究任务、已获取资料、GitHub Token 设置、尝试来源关联
CREATE TABLE research_runs (
  id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  capture_revision INTEGER NOT NULL,
  capture_text TEXT NOT NULL,
  question TEXT NOT NULL,
  constraints_json TEXT,
  search_mode TEXT NOT NULL,
  search_query TEXT,
  repo_inputs_json TEXT,
  status TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  candidates_json TEXT,
  selected_candidate_ids_json TEXT,
  sent_source_ids_json TEXT,
  result_json TEXT,
  config_id TEXT,
  config_version INTEGER,
  config_name TEXT,
  model_id TEXT,
  usage_json TEXT,
  duration_ms INTEGER,
  stats_json TEXT,
  error_code TEXT,
  error_detail TEXT,
  failed_json TEXT,
  operation_id TEXT UNIQUE,
  operation_fingerprint TEXT,
  context_token TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  saved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
--> statement-breakpoint
CREATE INDEX research_runs_capture_idx ON research_runs(capture_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX research_runs_status_idx ON research_runs(status);
--> statement-breakpoint
CREATE INDEX research_runs_saved_idx ON research_runs(saved_at DESC);
--> statement-breakpoint
CREATE TABLE research_sources (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  file_path TEXT,
  ref_name TEXT,
  commit_sha TEXT,
  excerpt TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  error_detail TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX research_sources_run_key_unique ON research_sources(research_id, source_key);
--> statement-breakpoint
CREATE INDEX research_sources_run_idx ON research_sources(research_id, repo_full_name);
--> statement-breakpoint
ALTER TABLE attempts ADD COLUMN source_research_id TEXT;
--> statement-breakpoint
ALTER TABLE attempts ADD COLUMN source_research_experiment_index INTEGER;
--> statement-breakpoint
ALTER TABLE attempts ADD COLUMN research_suggested_json TEXT;
--> statement-breakpoint
ALTER TABLE attempts ADD COLUMN research_source_ids_json TEXT;
--> statement-breakpoint
CREATE INDEX attempts_source_research_idx ON attempts(source_research_id);
--> statement-breakpoint
CREATE UNIQUE INDEX attempts_research_experiment_unique
  ON attempts(source_research_id, source_research_experiment_index)
  WHERE source_research_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE github_settings (
  id TEXT PRIMARY KEY,
  token_ciphertext TEXT NOT NULL,
  token_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
