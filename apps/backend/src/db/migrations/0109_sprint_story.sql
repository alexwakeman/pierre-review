-- ACTIVITY → THIS SPRINT: the SPRINT STORY (2026-10-14; docs/CLAUDE-REVIEW.md § Sprint story). The
-- Postgres twin is migrations-pg/0096_sprint_story.sql.
--
--   • `sprint_story`: ONE row per (account, workspace) — the sprint-wide Haiku pass's headline and
--     3–5 storylines (picked from code-built candidates), with the input hash and version that make it
--     current. Tenancy via the named composite FK onto `workspaces (id, account_id)`.
CREATE TABLE IF NOT EXISTS `sprint_story` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`input_hash` text NOT NULL,
	`story_version` integer NOT NULL,
	`story_json` text NOT NULL,
	`model` text NOT NULL,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `sprint_story_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sprint_story_account_ws` ON `sprint_story` (`account_id`,`workspace_id`);
