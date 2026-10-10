-- THE STORY REPORT (docs/CLAUDE-REVIEW.md § Story report; Reports → Stories). The Postgres twin is
-- migrations-pg/0084_story_reports.sql.
--
--   story_reports   NEW. One row per agentic run (Haiku 5.5) across 10-20 stories that CODE picked
--                   for a window choice ('reporting' | '30' | '60' | '90'). The LATEST row per
--                   (account, workspace, window_choice) is shown. `picked_json` / `population_json`
--                   are the code-computed picks and whole-window figures; `report_json` is the
--                   server-validated report, set only on 'succeeded'. `fingerprint` is the currency
--                   input (nothing derived from now).
--
-- Tenancy: `workspace_id` arrives in a request BODY, so its FK is the named COMPOSITE one onto
-- `workspaces (id, account_id)`. A workspace delete cascades (a report is regenerable). Listed in
-- `accountScopedTables()` and erased with the account.
CREATE TABLE IF NOT EXISTS `story_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`window_choice` text NOT NULL,
	`from_at` integer NOT NULL,
	`to_at` integer NOT NULL,
	`range_json` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`fingerprint` text NOT NULL,
	`picked_json` text NOT NULL,
	`population_json` text NOT NULL,
	`report_json` text,
	`dropped_json` text,
	`error` text,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`num_turns` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `story_reports_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `story_reports_account_ws_window_idx` ON `story_reports` (`account_id`,`workspace_id`,`window_choice`,`created_at`);
