-- REPORTS → THIS SPRINT: the graph's THEMES (2026-10-13; docs/CLAUDE-REVIEW.md § Sprint themes). The
-- Postgres twin is migrations-pg/0095_sprint_themes.sql.
--
--   • `sprint_themes`: ONE row per (account, workspace) — the sprint-wide Haiku pass's 3–8 theme names
--     and each sprint ticket's theme, with the input hash (keys + brief summaries) and version that make
--     it current. Tenancy via the named composite FK onto `workspaces (id, account_id)`.
CREATE TABLE IF NOT EXISTS `sprint_themes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`input_hash` text NOT NULL,
	`theme_version` integer NOT NULL,
	`themes_json` text NOT NULL,
	`assignments_json` text NOT NULL,
	`model` text NOT NULL,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `sprint_themes_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sprint_themes_account_ws` ON `sprint_themes` (`account_id`,`workspace_id`);
