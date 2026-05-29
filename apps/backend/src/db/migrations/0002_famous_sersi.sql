CREATE TABLE `my_turn_dismissals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`ref_id` integer NOT NULL,
	`dismissed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mtd_kind_ref_ux` ON `my_turn_dismissals` (`kind`,`ref_id`);--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `check_runs` text;