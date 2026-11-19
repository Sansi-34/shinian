-- 念头之间的手动关联（有方向）：A 关联到 B 与 B 被 A 关联读取同一行。
-- 稳定 ID 保存，编辑念头文字不影响；删除念头时由外键级联删除两端关联。
CREATE TABLE capture_links (
  id TEXT PRIMARY KEY,
  from_capture_id TEXT NOT NULL,
  to_capture_id TEXT NOT NULL,
  note TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT capture_links_from_capture_id_captures_id_fk
    FOREIGN KEY (from_capture_id) REFERENCES captures(id) ON DELETE cascade,
  CONSTRAINT capture_links_to_capture_id_captures_id_fk
    FOREIGN KEY (to_capture_id) REFERENCES captures(id) ON DELETE cascade,
  CONSTRAINT capture_links_no_self CHECK (from_capture_id <> to_capture_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX capture_links_pair_unique ON capture_links(from_capture_id, to_capture_id);
--> statement-breakpoint
CREATE INDEX capture_links_from_idx ON capture_links(from_capture_id);
--> statement-breakpoint
CREATE INDEX capture_links_to_idx ON capture_links(to_capture_id);
