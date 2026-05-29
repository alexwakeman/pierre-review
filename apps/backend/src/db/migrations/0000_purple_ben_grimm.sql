CREATE TABLE `commit_files` (
	`sha` text PRIMARY KEY NOT NULL,
	`paths` text NOT NULL,
	`fetched_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `commits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sha` text NOT NULL,
	`pr_id` integer NOT NULL,
	`author_id` integer,
	`committer_id` integer,
	`message` text,
	`committed_at` integer NOT NULL,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`committer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `commit_pr_idx` ON `commits` (`pr_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `commit_sha_pr_ux` ON `commits` (`sha`,`pr_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`actor_id` integer,
	`pr_id` integer,
	`type` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`ref_table` text,
	`ref_id` integer,
	`dedupe_key` text NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_dedupe_key_unique` ON `events` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `events_time_idx` ON `events` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `events_repo_time_idx` ON `events` (`repo_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `events_actor_idx` ON `events` (`actor_id`);--> statement-breakpoint
CREATE TABLE `pr_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_node_id` text NOT NULL,
	`pr_id` integer NOT NULL,
	`author_id` integer,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pr_comments_github_node_id_unique` ON `pr_comments` (`github_node_id`);--> statement-breakpoint
CREATE INDEX `prc_pr_idx` ON `pr_comments` (`pr_id`);--> statement-breakpoint
CREATE TABLE `pull_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_node_id` text NOT NULL,
	`repo_id` integer NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`author_id` integer,
	`state` text NOT NULL,
	`is_draft` integer DEFAULT false NOT NULL,
	`opened_at` integer NOT NULL,
	`first_review_at` integer,
	`last_commit_at` integer,
	`merged_at` integer,
	`closed_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_github_node_id_unique` ON `pull_requests` (`github_node_id`);--> statement-breakpoint
CREATE INDEX `pr_repo_idx` ON `pull_requests` (`repo_id`);--> statement-breakpoint
CREATE INDEX `pr_opened_idx` ON `pull_requests` (`opened_at`);--> statement-breakpoint
CREATE TABLE `repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`github_node_id` text NOT NULL,
	`backfill_until` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_github_node_id_unique` ON `repos` (`github_node_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `repos_owner_name` ON `repos` (`owner`,`name`);--> statement-breakpoint
CREATE TABLE `review_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_node_id` text NOT NULL,
	`thread_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`author_id` integer,
	`body` text NOT NULL,
	`diff_hunk` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `review_threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_comments_github_node_id_unique` ON `review_comments` (`github_node_id`);--> statement-breakpoint
CREATE INDEX `rc_thread_idx` ON `review_comments` (`thread_id`);--> statement-breakpoint
CREATE TABLE `review_threads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_node_id` text NOT NULL,
	`pr_id` integer NOT NULL,
	`path` text NOT NULL,
	`line` integer,
	`is_resolved` integer NOT NULL,
	`is_outdated` integer DEFAULT false NOT NULL,
	`derived_state` text NOT NULL,
	`original_commenter_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`original_commenter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_threads_github_node_id_unique` ON `review_threads` (`github_node_id`);--> statement-breakpoint
CREATE INDEX `thread_pr_idx` ON `review_threads` (`pr_id`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_node_id` text NOT NULL,
	`pr_id` integer NOT NULL,
	`author_id` integer,
	`state` text NOT NULL,
	`body` text,
	`submitted_at` integer NOT NULL,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_github_node_id_unique` ON `reviews` (`github_node_id`);--> statement-breakpoint
CREATE INDEX `rv_pr_idx` ON `reviews` (`pr_id`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`repo_id` integer PRIMARY KEY NOT NULL,
	`last_full_sync_at` integer,
	`last_incremental_sync_at` integer,
	`last_sync_status` text,
	`last_sync_error` text,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_login` text NOT NULL,
	`github_node_id` text,
	`display_name` text,
	`avatar_url` text,
	`is_bot` integer DEFAULT false NOT NULL,
	`is_bot_overridden` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_login_unique` ON `users` (`github_login`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_node_id_unique` ON `users` (`github_node_id`);