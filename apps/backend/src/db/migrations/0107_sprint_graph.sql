-- REPORTS → THIS SPRINT AS A GRAPH (2026-10-12; docs/TRACKERS.md § The sprint list read → Ghost
-- chains, docs/CLAUDE-REVIEW.md § Sprint briefs). The Postgres twin is
-- migrations-pg/0094_sprint_graph.sql.
--
--   • `sprint_ref_tickets` gains the referenced ticket's TEXT (description, criteria), type, assignee,
--     tracker links and `depth` (hops from the sprint) — a ghost is briefed like a sprint ticket and its
--     own references are followed. Additive; existing rows read depth 1.
--   • `sprint_briefs`: one Haiku brief per (account, workspace, ticket ident) — summary, itemised
--     criteria, references. Tenancy via the named composite FK onto `workspaces (id, account_id)`.
--   • `tracker_writes` is DROPPED: the write-back is removed. (`workspaces.sprint_checks` stays, dormant.)
ALTER TABLE `sprint_ref_tickets` ADD `description` text;
--> statement-breakpoint
ALTER TABLE `sprint_ref_tickets` ADD `acceptance_criteria` text;
--> statement-breakpoint
ALTER TABLE `sprint_ref_tickets` ADD `issue_type_name` text;
--> statement-breakpoint
ALTER TABLE `sprint_ref_tickets` ADD `assignee_name` text;
--> statement-breakpoint
ALTER TABLE `sprint_ref_tickets` ADD `assignee_avatar_url` text;
--> statement-breakpoint
ALTER TABLE `sprint_ref_tickets` ADD `blocked_by_json` text;
--> statement-breakpoint
ALTER TABLE `sprint_ref_tickets` ADD `depth` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sprint_briefs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`ident` text NOT NULL,
	`text_hash` text NOT NULL,
	`brief_version` integer NOT NULL,
	`summary` text NOT NULL,
	`criteria_json` text NOT NULL,
	`criteria_derived` integer DEFAULT false NOT NULL,
	`references_json` text NOT NULL,
	`model` text NOT NULL,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `sprint_briefs_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sprint_briefs_account_ws_ident` ON `sprint_briefs` (`account_id`,`workspace_id`,`ident`);
--> statement-breakpoint
DROP TABLE IF EXISTS `tracker_writes`;
