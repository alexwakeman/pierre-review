-- ACTIVITY → THIS SPRINT: "SINCE YOU LAST LOOKED" (2026-10-14; docs/CLAUDE-REVIEW.md § Sprint story →
-- The code cards). The Postgres twin is migrations-pg/0099_sprint_view_snapshots.sql.
--
--   • `sprint_view_snapshots`: ONE row per (account, workspace), two slots — `current_json` (the latest
--     view's snapshot: each sprint ticket's stage + the merged pull requests on sprint tickets) and
--     `baseline_json` (the previous visit's last view). A view rolls current into baseline only after a
--     gap (SPRINT_VISIT_GAP_MS). Tenancy via the named composite FK onto `workspaces (id, account_id)`.
CREATE TABLE IF NOT EXISTS `sprint_view_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`current_json` text NOT NULL,
	`current_at` integer NOT NULL,
	`baseline_json` text,
	`baseline_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `sprint_view_snapshots_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sprint_view_snapshots_account_ws` ON `sprint_view_snapshots` (`account_id`,`workspace_id`);
