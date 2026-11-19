-- 主题：一组稳定 capture ID 的集合 + 用户写下的探索问题/继续说明 + 可选固定下一步。
-- 不复制正文；成员只存 topic_id + capture_id + member_kind。
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  exploring_question TEXT,
  continue_note TEXT,
  next_attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
  next_attempt_cleared_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS topics_archived_updated_idx ON topics (archived_at, updated_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS topics_updated_idx ON topics (updated_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS topic_members (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  member_kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS topic_members_topic_capture_unique ON topic_members (topic_id, capture_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS topic_members_topic_created_idx ON topic_members (topic_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS topic_members_capture_idx ON topic_members (capture_id);
