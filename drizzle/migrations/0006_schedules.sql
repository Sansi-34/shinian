CREATE TABLE `schedule_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`timezone` text NOT NULL,
	`note` text,
	`status` text DEFAULT 'active' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`cancelled_at` integer,
	CONSTRAINT `schedule_blocks_attempt_id_attempts_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `schedule_blocks_status_range_idx` ON `schedule_blocks` (`status`,`starts_at`,`ends_at`);
--> statement-breakpoint
CREATE INDEX `schedule_blocks_attempt_start_idx` ON `schedule_blocks` (`attempt_id`,`starts_at`);
--> statement-breakpoint
CREATE INDEX `schedule_blocks_starts_idx` ON `schedule_blocks` (`starts_at`);
