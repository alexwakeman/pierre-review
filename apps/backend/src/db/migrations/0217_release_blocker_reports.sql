-- THIS SPRINT → RELEASES: "Explain what's blocking" (2026-11-23; docs/RELEASES.md § Explain what's blocking).
-- ONE row per (account, workspace): the last report a reader's press wrote over the release check, the hash
-- of the input it was written from, and what ran. Additive; no backfill. Tenancy via the named composite FK
-- onto `workspaces (id, account_id)`.
CREATE TABLE IF NOT EXISTS `release_blocker_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`input_hash` text NOT NULL,
	`report_json` text NOT NULL,
	`model` text,
	`provider` text,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`written_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `release_blocker_reports_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `release_blocker_reports_account_ws` ON `release_blocker_reports` (`account_id`,`workspace_id`);
