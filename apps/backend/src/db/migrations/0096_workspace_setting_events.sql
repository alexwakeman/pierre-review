-- WORKSPACE SETTINGS HISTORY (docs/BOTTLENECKS.md § Over time). The Postgres twin is
-- migrations-pg/0083_workspace_setting_events.sql.
--
--   workspace_setting_events   NEW, APPEND-ONLY. One row per REAL change to a workspace setting that
--                              can move how work flows (auto review, auto fix, auto-posting, working
--                              hours and budgets, dependency auto-merge, the issue tracker): a kind,
--                              a short plain-English summary, and when it happened. Read by
--                              Chronology's "Over time" charts as event markers.
--
-- ⚠ GOING FORWARD ONLY. There was no settings history before this table, so nothing is backfilled and
-- the page says when the history starts (the first row's date). Rows are never updated.
--
-- Tenancy: `workspace_id` comes from a request PATH on every writer, so its FK is the named COMPOSITE
-- one onto `workspaces (id, account_id)` (the workspace_trackers precedent). Listed in
-- `accountScopedTables()` and erased with the account.
CREATE TABLE IF NOT EXISTS `workspace_setting_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`occurred_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `workspace_setting_events_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workspace_setting_events_account_ws_time_idx` ON `workspace_setting_events` (`account_id`,`workspace_id`,`occurred_at`);
