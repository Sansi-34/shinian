-- 问我的记录：一次只读问答任务。问题、关键词、日期范围、发送记录快照、
-- 带来源的回答与模型用量都保存；不修改念头/尝试/引用等业务记录。
CREATE TABLE record_queries (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '',
  range_from INTEGER,
  range_to INTEGER,
  status TEXT NOT NULL,
  answer_json TEXT,
  sources_json TEXT,
  config_id TEXT,
  config_version INTEGER,
  config_name TEXT,
  model_id TEXT,
  usage_json TEXT,
  duration_ms INTEGER,
  error_code TEXT,
  error_detail TEXT,
  operation_id TEXT UNIQUE,
  operation_fingerprint TEXT,
  context_token TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
--> statement-breakpoint
CREATE INDEX record_queries_created_idx ON record_queries(created_at DESC);
--> statement-breakpoint
CREATE INDEX record_queries_status_idx ON record_queries(status);
