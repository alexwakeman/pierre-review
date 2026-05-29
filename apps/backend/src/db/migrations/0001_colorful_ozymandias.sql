CREATE TABLE `local_user` (
	`id` integer PRIMARY KEY NOT NULL,
	`github_login` text NOT NULL,
	`github_id` text NOT NULL,
	`avatar_url` text,
	`cached_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pr_views` (
	`pr_id` integer PRIMARY KEY NOT NULL,
	`last_viewed_sha` text,
	`last_viewed_at` integer NOT NULL,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `review_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pr_id` integer NOT NULL,
	`user_id` integer,
	`team_name` text,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rr_pr_idx` ON `review_requests` (`pr_id`);--> statement-breakpoint
CREATE INDEX `rr_user_idx` ON `review_requests` (`user_id`);--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `head_sha` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `ci_status` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `mergeable` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `merge_state_status` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `labels` text;