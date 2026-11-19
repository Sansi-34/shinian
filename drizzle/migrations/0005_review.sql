CREATE TABLE `stage_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`range_from` integer NOT NULL,
	`range_to` integer NOT NULL,
	`timezone` text NOT NULL,
	`range_preset` text NOT NULL,
	`stats_json` text,
	`coverage_json` text,
	`content_json` text,
	`sources_json` text,
	`config_id` text,
	`config_version` integer,
	`config_name` text,
	`model_id` text,
	`error_code` text,
	`error_detail` text,
	`usage_json` text,
	`duration_ms` integer,
	`operation_id` text,
	`operation_fingerprint` text,
	`context_token` text,
	`saved_at` integer,
	`content_invalidated_at` integer,
	`content_invalid_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stage_reviews_operation_id_unique` ON `stage_reviews` (`operation_id`);
--> statement-breakpoint
CREATE INDEX `stage_reviews_saved_idx` ON `stage_reviews` (`saved_at` DESC);
--> statement-breakpoint
CREATE INDEX `stage_reviews_created_idx` ON `stage_reviews` (`created_at` DESC);
--> statement-breakpoint
CREATE INDEX `stage_reviews_status_idx` ON `stage_reviews` (`status`);
