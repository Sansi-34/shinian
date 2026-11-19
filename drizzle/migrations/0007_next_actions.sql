ALTER TABLE `attempts` ADD COLUMN `origin` text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `action_description` text;
--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `estimated_minutes` integer;
--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `source_review_id` text;
--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `source_experience_index` integer;
--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `source_attempt_id` text;
--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `source_attempt_revision` integer;
--> statement-breakpoint
CREATE INDEX `attempts_origin_created_idx` ON `attempts` (`origin`,`created_at` DESC);
--> statement-breakpoint
CREATE INDEX `attempts_source_review_idx` ON `attempts` (`source_review_id`);
