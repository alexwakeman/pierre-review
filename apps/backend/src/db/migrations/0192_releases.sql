-- RELEASES (2026-11-14; docs/RELEASES.md). CORE, additive.
--
--   pull_requests.merge_commit_oid   the commit a PR landed as (GraphQL mergeCommit.oid). Cleared only
--                                    on a positive statement (sync/upsert.ts).
--   workspaces.release_suffix /      the per-workspace release and hotfix tag suffixes. NULL = not set;
--   workspaces.hotfix_suffix         no default (shared validateReleaseSettings).
--   repos.tags_signature / tags_synced_at   what the last complete tag read saw (sync/repo-tags.ts).
--   repo_tags                        NEW: one row per (account, repo, tag name).
--   repo_tag_ranges                  NEW: the PRs between a tag and the tag before it.
--   releases / release_items / release_ticket_comments   NEW: one press of "Create release…", its
--                                    per-repo writes and its per-ticket tracker comments.
ALTER TABLE `pull_requests` ADD COLUMN `merge_commit_oid` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pr_account_repo_merge_commit_idx` ON `pull_requests` (`account_id`,`repo_id`,`merge_commit_oid`);
--> statement-breakpoint
ALTER TABLE `workspaces` ADD COLUMN `release_suffix` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD COLUMN `hotfix_suffix` text;
--> statement-breakpoint
ALTER TABLE `repos` ADD COLUMN `tags_signature` text;
--> statement-breakpoint
ALTER TABLE `repos` ADD COLUMN `tags_synced_at` integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `repo_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`name` text NOT NULL,
	`sha` text NOT NULL,
	`tag_object_oid` text,
	`committed_at` integer,
	`tagged_at` integer,
	`on_default_branch` integer,
	`ancestry_head_sha` text,
	`previous_sha` text,
	`moved_at` integer,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `repo_tags_repo_account_fk` FOREIGN KEY (`repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `repo_tags_account_repo_name` ON `repo_tags` (`account_id`,`repo_id`,`name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `repo_tags_account_repo_sha_idx` ON `repo_tags` (`account_id`,`repo_id`,`sha`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `repo_tag_ranges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`tag_name` text NOT NULL,
	`sha` text NOT NULL,
	`base_tag_name` text,
	`base_sha` text,
	`method` text NOT NULL,
	`pr_numbers` text NOT NULL,
	`commit_count` integer DEFAULT 0 NOT NULL,
	`unmatched_commits` integer DEFAULT 0 NOT NULL,
	`truncated` integer DEFAULT 0 NOT NULL,
	`moved_from_sha` text,
	`computed_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `repo_tag_ranges_repo_account_fk` FOREIGN KEY (`repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `repo_tag_ranges_account_repo_tag` ON `repo_tag_ranges` (`account_id`,`repo_id`,`tag_name`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `releases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`created_by_user_id` integer,
	`created_by_login` text,
	`created_at` integer NOT NULL,
	`release_suffix` text NOT NULL,
	`notes_markdown` text DEFAULT '' NOT NULL,
	`state` text NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `releases_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `releases_account_workspace_idx` ON `releases` (`account_id`,`workspace_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `releases_id_account` ON `releases` (`id`,`account_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `release_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`release_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`version_tag` text NOT NULL,
	`sha` text NOT NULL,
	`release_tag_name` text NOT NULL,
	`notes_markdown` text DEFAULT '' NOT NULL,
	`tag_state` text DEFAULT 'pending' NOT NULL,
	`tag_object_oid` text,
	`prerelease_state` text DEFAULT 'pending' NOT NULL,
	`github_release_id` integer,
	`github_release_url` text,
	`error` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `release_items_release_account_fk` FOREIGN KEY (`release_id`,`account_id`) REFERENCES `releases`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `release_items_repo_account_fk` FOREIGN KEY (`repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `release_items_account_release_repo` ON `release_items` (`account_id`,`release_id`,`repo_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `release_items_account_repo_tag` ON `release_items` (`account_id`,`repo_id`,`release_tag_name`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `release_ticket_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`release_id` integer NOT NULL,
	`ticket_key` text NOT NULL,
	`tracker_kind` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`comment_id` text,
	`error` text,
	`claimed_at` integer,
	`posted_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `release_ticket_comments_release_account_fk` FOREIGN KEY (`release_id`,`account_id`) REFERENCES `releases`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `release_ticket_comments_account_release_ticket` ON `release_ticket_comments` (`account_id`,`release_id`,`ticket_key`);
