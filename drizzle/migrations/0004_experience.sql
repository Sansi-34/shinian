ALTER TABLE `ai_generations` ADD COLUMN `context_json` text;
--> statement-breakpoint
ALTER TABLE `ai_generations` ADD COLUMN `context_token` text;
--> statement-breakpoint
ALTER TABLE `ai_generations` ADD COLUMN `context_invalidated_at` integer;
--> statement-breakpoint
ALTER TABLE `ai_generations` ADD COLUMN `context_invalid_reason` text;
