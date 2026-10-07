-- THE ISSUE TRACKER MOVES TO CORE (apiVersion 23). Ticket links, the stored tickets, the story panel
-- and the Open PRs ticket stacks are FREE and run in the public `npx limn-review` install, so their
-- tables leave the private plugin. The Postgres twin is migrations-pg/0075_issue_tracker.sql;
-- docs/TRACKERS.md has the contract and docs/MIGRATIONS.md the history.
--
--   workspace_trackers   NEW. ONE tracker per workspace: provider, base URL, project-key allowlist,
--                        match scope, and the Jira email + SEALED token. The values move here from
--                        the plugin's `pro_workspace_settings` (plugin 0031/0035).
--   tracker_tickets      NEW. The provider-aware generalisation of the plugin's
--                        `pro_pr_jira_tickets` (plugin 0038/0039) — the same columns plus
--                        `provider` (DEFAULT 'jira': every row that existed was a Jira row).
--   pro_jira_ac_fields   ADOPTED IN PLACE, exactly the ai_fixes precedent (0074): same name, same
--                        columns, same index name. Where the plugin created it this is a no-op and
--                        its rows stay; on a fresh or plugin-less install it is created here.
--
-- ⚠ NO DATA IS COPIED BY THIS FILE, AND THAT IS DELIBERATE. The source rows live in PLUGIN tables,
-- which do not exist on a fresh install, on a plugin-less install, or (in the pg twin's case) may
-- not exist at all — and SQLite has no conditional DDL/DML to test for a table. The values are
-- MOVED by a guarded BOOT-TIME step instead (src/tracker/legacy-import.ts, run after the plugin
-- binds): it tests each source table and column for existence, copies with ON CONFLICT DO NOTHING,
-- and then CLEARS the source (deletes the ticket rows, NULLs the tracker columns) in the same
-- transaction — so a second boot finds nothing to move, a token is never left in two places, and a
-- value cleared in core is never resurrected from the old copy.
--
-- ⚠ WHY A NEW TICKETS TABLE RATHER THAN ADOPTING `pro_pr_jira_tickets` + ADD COLUMN `provider`.
-- Adopting needs `ALTER TABLE … ADD COLUMN provider` on a table this file may or may not have just
-- created, and `changed_at` (plugin 0039) may or may not already be on it — SQLite has no
-- ADD COLUMN IF NOT EXISTS, so one of the two install shapes would fail the boot. A new table has
-- one shape everywhere. Plugin 0038/0039 are stripped to no-ops in the same change, so a fresh
-- install never grows the old table at all.
--
-- Tenancy: `workspace_trackers.workspace_id` arrives in a request PATH, so its FK is the named
-- COMPOSITE one onto `workspaces (id, account_id)`. `tracker_tickets` and `pro_jira_ac_fields` are
-- written only by the server (the worker, and a route that resolves the PR's own workspace): no FKs,
-- like the tables they replace; every read predicates on account_id, both delete paths prune
-- tracker_tickets, and all three are in `accountScopedTables()`.
CREATE TABLE IF NOT EXISTS `workspace_trackers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`provider` text,
	`base_url` text,
	`project_keys` text,
	`match_scope` text,
	`auth_email` text,
	`auth_token` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `workspace_trackers_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `workspace_trackers_account_workspace` ON `workspace_trackers` (`account_id`,`workspace_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tracker_tickets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`provider` text DEFAULT 'jira' NOT NULL,
	`issue_key` text NOT NULL,
	`detected_from` text NOT NULL,
	`detect_order` integer NOT NULL,
	`api_root` text NOT NULL,
	`url` text NOT NULL,
	`state` text NOT NULL,
	`error_code` text,
	`title` text,
	`description` text,
	`acceptance_criteria` text,
	`ac_field_id` text,
	`ac_field_name` text,
	`ac_field_source` text,
	`issue_type_id` text,
	`issue_type_name` text,
	`status_name` text,
	`status_category` text,
	`assignee_name` text,
	`assignee_account_id` text,
	`assignee_avatar_url` text,
	`candidates_json` text,
	`omitted_candidates` integer DEFAULT 0 NOT NULL,
	`fetched_at` integer,
	`checked_at` integer NOT NULL,
	`next_check_at` integer NOT NULL,
	`changed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tracker_tickets_account_pr_key` ON `tracker_tickets` (`account_id`,`pr_id`,`issue_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tracker_tickets_account_ws_type` ON `tracker_tickets` (`account_id`,`workspace_id`,`issue_type_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tracker_tickets_account_site_key` ON `tracker_tickets` (`account_id`,`provider`,`api_root`,`issue_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tracker_tickets_account_changed` ON `tracker_tickets` (`account_id`,`changed_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tracker_tickets_pr` ON `tracker_tickets` (`pr_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pro_jira_ac_fields` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`api_root` text NOT NULL,
	`issue_type_id` text NOT NULL,
	`field_id` text NOT NULL,
	`field_name` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `pro_jira_ac_fields_account_ws_site_type` ON `pro_jira_ac_fields` (`account_id`,`workspace_id`,`api_root`,`issue_type_id`);
