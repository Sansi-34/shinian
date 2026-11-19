CREATE TABLE `attempt_references` (
	`id` text PRIMARY KEY NOT NULL,
	`from_attempt_id` text NOT NULL,
	`to_attempt_id` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`note` text,
	`snapshot_result_text` text,
	`snapshot_revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`from_attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`capture_id` text NOT NULL,
	`step` text NOT NULL,
	`state` text DEFAULT 'todo' NOT NULL,
	`result_text` text,
	`outcome` text,
	`source_url` text,
	`observed_at` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`capture_id`) REFERENCES `captures`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `captures` (
	`id` text PRIMARY KEY NOT NULL,
	`raw_text` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE TABLE `source_links` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`label` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
