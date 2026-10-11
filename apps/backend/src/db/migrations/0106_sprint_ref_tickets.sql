-- REPORTS → THIS SPRINT: the STATUS of tickets the sprint's text names that Limn holds nowhere else
-- (docs/TRACKERS.md § The sprint list read → Referenced tickets). The Postgres twin is
-- migrations-pg/0093_sprint_ref_tickets.sql. Additive.
--
--   • `sprint_ref_tickets`: one row per (account, workspace, ticket ident) — key, title, status — written
--     only by the sprint read's ONE batched lookup and replaced by each successful one. Tenancy via the
--     named composite FK onto `workspaces (id, account_id)`.
CREATE TABLE IF NOT EXISTS `sprint_ref_tickets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`ident` text NOT NULL,
	`provider` text NOT NULL,
	`api_root` text NOT NULL,
	`issue_key` text NOT NULL,
	`title` text,
	`status_name` text,
	`status_category` text,
	`url` text,
	`read_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `sprint_ref_tickets_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sprint_ref_tickets_account_ws_ident` ON `sprint_ref_tickets` (`account_id`,`workspace_id`,`ident`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sprint_ref_tickets_account_key` ON `sprint_ref_tickets` (`account_id`,`issue_key`);
