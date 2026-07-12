-- Bot-Triage Platform (WS6): account-scoped mute / auto-triage rules. A rule matches
-- automated-reviewer threads by vendor_kind × path_glob × severity (null = any) and
-- either 'hide's them from the noise counts/feed or (with auto_resolve_days) marks
-- likely_addressed threads older than N days for the standing auto-resolve job.
-- Account-scoped isolation. The Postgres baseline is regenerated separately via
-- `pnpm db:generate:pg`.
CREATE TABLE `bot_mute_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`vendor_kind` text,
	`path_glob` text,
	`severity` text,
	`action` text NOT NULL,
	`auto_resolve_days` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bmr_account_idx` ON `bot_mute_rules` (`account_id`);
