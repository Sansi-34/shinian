CREATE TABLE IF NOT EXISTS `ai_assist_logs` (
  `id` text PRIMARY KEY NOT NULL,
  `model_id` text NOT NULL,
  `config_name` text NOT NULL,
  `status` text NOT NULL,
  `usage_json` text,
  `duration_ms` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ai_assist_logs_created_idx` ON `ai_assist_logs` (`created_at`);
