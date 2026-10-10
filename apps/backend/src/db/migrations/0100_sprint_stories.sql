-- REPORTS → THIS SPRINT (packages/shared/src/sprint-stories.ts; docs/TRACKERS.md § The sprint list
-- read; docs/CLAUDE-REVIEW.md § Sprint assessment). The Postgres twin is
-- migrations-pg/0087_sprint_stories.sql. Five NEW tables, each with its own `account_id`, listed in
-- `accountScopedTables()` and erased with the account:
--
--   sprint_reads         one row per (account, workspace): what the stored sprint list is
--                        (`source_json`), when it was read, and when the tab was last opened — the
--                        DEMAND GATE for the first tracker read not triggered by a received PR.
--   sprint_tickets       one row per (account, workspace, ticket ident) the sprint read returned,
--                        with its text — with or without a pull request.
--   sprint_ticket_repos  the repos a reader ACCEPTED as candidates for one ticket.
--   sprint_assessments   one row per "Assess with code" run (local-only, Sonnet 5).
--   tracker_writes       one row per confirmed write-back press; inserted BEFORE the tracker call
--                        (the claim), never retried.
--
-- Tenancy: every `workspace_id` and `repo_id` that arrives in a request is a NAMED COMPOSITE FK
-- against `(id, account_id)` (the `workspaces_id_account` / `repos_id_account` parent keys).
CREATE TABLE IF NOT EXISTS `sprint_reads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`provider` text,
	`source_json` text,
	`read_at` integer,
	`checked_at` integer,
	`next_read_at` integer NOT NULL,
	`error_code` text,
	`truncated` integer DEFAULT false NOT NULL,
	`viewed_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `sprint_reads_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sprint_reads_account_workspace` ON `sprint_reads` (`account_id`,`workspace_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sprint_tickets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`ident` text NOT NULL,
	`provider` text NOT NULL,
	`api_root` text NOT NULL,
	`issue_key` text NOT NULL,
	`url` text,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`acceptance_criteria` text DEFAULT '' NOT NULL,
	`ac_field_id` text,
	`ac_field_name` text,
	`candidates_json` text,
	`omitted_candidates` integer DEFAULT 0 NOT NULL,
	`issue_type_id` text,
	`issue_type_name` text,
	`status_name` text,
	`status_category` text,
	`assignee_name` text,
	`assignee_avatar_url` text,
	`project_key` text,
	`epic_key` text,
	`epic_title` text,
	`components_json` text,
	`sprint_name` text,
	`in_sprint` integer DEFAULT true NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`fetched_at` integer NOT NULL,
	`next_check_at` integer NOT NULL,
	`issue_updated_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `sprint_tickets_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sprint_tickets_account_ws_ident` ON `sprint_tickets` (`account_id`,`workspace_id`,`ident`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sprint_tickets_account_ident` ON `sprint_tickets` (`account_id`,`ident`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sprint_ticket_repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`ident` text NOT NULL,
	`repo_id` integer NOT NULL,
	`via` text NOT NULL,
	`accepted_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `sprint_ticket_repos_repo_account_fk` FOREIGN KEY (`repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `sprint_ticket_repos_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sprint_ticket_repos_identity` ON `sprint_ticket_repos` (`account_id`,`workspace_id`,`ident`,`repo_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sprint_assessments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`ident` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`phase` text,
	`fingerprint` text NOT NULL,
	`text_hash` text NOT NULL,
	`repos_json` text NOT NULL,
	`body_json` text,
	`dropped_json` text,
	`error` text,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`num_turns` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `sprint_assessments_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sprint_assessments_account_ws_ident_idx` ON `sprint_assessments` (`account_id`,`workspace_id`,`ident`,`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tracker_writes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`ident` text NOT NULL,
	`provider` text NOT NULL,
	`request_id` text NOT NULL,
	`mode` text NOT NULL,
	`target_json` text,
	`text` text NOT NULL,
	`text_hash` text NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`url` text,
	`assessment_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `tracker_writes_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tracker_writes_account_request` ON `tracker_writes` (`account_id`,`request_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tracker_writes_account_ident_idx` ON `tracker_writes` (`account_id`,`workspace_id`,`ident`,`created_at`);
