CREATE TABLE `ai_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`model_id` text NOT NULL,
	`api_key_ciphertext` text NOT NULL,
	`api_key_fingerprint` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`allow_local` integer DEFAULT 0 NOT NULL,
	`config_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`test_status` text,
	`tested_at` integer,
	`test_model_id` text,
	`test_base_url` text,
	`test_duration_ms` integer,
	`test_error_code` text,
	`test_error_detail` text,
	`test_fingerprint` text
);
--> statement-breakpoint
CREATE TABLE `ai_generations` (
	`id` text PRIMARY KEY NOT NULL,
	`capture_id` text NOT NULL,
	`capture_revision` integer NOT NULL,
	`capture_text` text NOT NULL,
	`constraint_text` text,
	`config_id` text NOT NULL,
	`config_version` integer NOT NULL,
	`config_name` text NOT NULL,
	`base_url` text NOT NULL,
	`model_id` text NOT NULL,
	`status` text NOT NULL,
	`kind` text,
	`suggestion_json` text,
	`error_code` text,
	`error_detail` text,
	`usage_json` text,
	`duration_ms` integer,
	`adopted_attempt_id` text,
	`adopted_at` integer,
	`dismissed_at` integer,
	`operation_id` text,
	`operation_fingerprint` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`capture_id`) REFERENCES `captures`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`adopted_attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_generations_operation_id_unique` ON `ai_generations` (`operation_id`);
--> statement-breakpoint
CREATE INDEX `ai_generations_capture_created_idx` ON `ai_generations` (`capture_id`,`created_at` DESC);
--> statement-breakpoint
CREATE INDEX `ai_generations_status_idx` ON `ai_generations` (`status`);
