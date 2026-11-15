-- RELEASES: THE ONE HISTORY PASS (2026-11-15; docs/RELEASES.md § Implementation → One history pass).
-- CORE, additive. The release scan reads the default branch's first-parent history once (GraphQL
-- `history` with each commit's PRs) instead of a REST compare per tag and a full sync per old PR.
--
--   release_history_scans    NEW: one row per (account, repo): the walk's cursors and segments.
--   release_history_commits  NEW: one row per first-parent commit walked: its order and its PRs.
--   release_range_prs        NEW: the LIGHT record of a range PR (title, head branch, author, merge).
--   tracker_ticket_status    NEW: a ticket status read in a batch, per (account, workspace, ident).
--
-- `repo_tag_ranges` and `repo_tags.on_default_branch` / `ancestry_head_sha` become DORMANT (no
-- writer): kept, never dropped.
CREATE TABLE IF NOT EXISTS `release_history_scans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`top_sha` text NOT NULL,
	`max_base` integer DEFAULT 0 NOT NULL,
	`deep_start_sha` text NOT NULL,
	`deep_cursor` text,
	`deep_expected_sha` text,
	`deep_next_idx` integer DEFAULT 0 NOT NULL,
	`deep_estimate` integer,
	`tip_start_sha` text,
	`tip_stop_sha` text,
	`tip_cursor` text,
	`tip_expected_sha` text,
	`tip_next_idx` integer DEFAULT 0 NOT NULL,
	`tip_base` integer,
	`tip_estimate` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `release_history_scans_repo_account_fk` FOREIGN KEY (`repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `release_history_scans_account_repo` ON `release_history_scans` (`account_id`,`repo_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `release_history_commits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`sha` text NOT NULL,
	`seq` integer NOT NULL,
	`pr_numbers` text NOT NULL,
	`committed_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `release_history_commits_repo_account_fk` FOREIGN KEY (`repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `release_history_commits_account_repo_sha` ON `release_history_commits` (`account_id`,`repo_id`,`sha`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `release_history_commits_account_repo_seq_idx` ON `release_history_commits` (`account_id`,`repo_id`,`seq`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `release_range_prs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`head_ref_name` text,
	`author_login` text,
	`is_bot` integer DEFAULT false NOT NULL,
	`merged_at` integer,
	`merge_sha` text,
	`url` text NOT NULL,
	`seen_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `release_range_prs_repo_account_fk` FOREIGN KEY (`repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `release_range_prs_account_repo_number` ON `release_range_prs` (`account_id`,`repo_id`,`number`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tracker_ticket_status` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`provider` text NOT NULL,
	`api_root` text NOT NULL,
	`issue_key` text NOT NULL,
	`ident` text NOT NULL,
	`state` text NOT NULL,
	`status_name` text,
	`status_category` text,
	`title` text,
	`url` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`fetched_at` integer,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `tracker_ticket_status_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tracker_ticket_status_account_ws_ident` ON `tracker_ticket_status` (`account_id`,`workspace_id`,`ident`);
