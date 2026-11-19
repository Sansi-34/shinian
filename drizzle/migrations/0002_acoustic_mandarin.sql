CREATE TABLE `mutation_receipts` (
	`operation_key` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_references_pair_unique` ON `attempt_references` (`from_attempt_id`,`to_attempt_id`);
