-- ACTIVITY → THIS SPRINT: the SPRINT BUILDER's critical paths (2026-10-17; docs/CLAUDE-REVIEW.md §
-- Sprint paths). The Postgres twin is migrations-pg/0107_sprint_paths.sql.
--
--   • `sprint_paths`: ONE row per (account, workspace) — the agentic Sonnet 5 pass's last stored answer
--     (paths + call-outs, ticket keys only) with its input hash and version, the last attempt (when, for
--     which input, the failure code) and today's run count against SPRINT_PATHS_DAILY_CAP. Tenancy via
--     the named composite FK onto `workspaces (id, account_id)`.
--   • It replaces the Haiku sprint story: `sprint_story` and `sprint_reads.story_attempt_*` are DORMANT
--     from here on (kept, never written).
CREATE TABLE IF NOT EXISTS `sprint_paths` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`input_hash` text,
	`paths_version` integer,
	`paths_json` text,
	`model` text,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`written_at` integer,
	`attempt_at` integer,
	`attempt_hash` text,
	`attempt_error` text,
	`runs_day` text,
	`runs_today` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `sprint_paths_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sprint_paths_account_ws` ON `sprint_paths` (`account_id`,`workspace_id`);
