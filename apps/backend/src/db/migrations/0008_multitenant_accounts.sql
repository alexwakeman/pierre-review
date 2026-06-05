CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_user_id` text NOT NULL,
	`github_login` text NOT NULL,
	`avatar_url` text,
	`access_token_enc` text,
	`is_local` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_github_user_id_unique` ON `accounts` (`github_user_id`);--> statement-breakpoint
INSERT INTO `accounts` (`id`, `github_user_id`, `github_login`, `avatar_url`, `is_local`, `created_at`, `last_login_at`)
	SELECT 1, COALESCE(`github_id`, ''), COALESCE(`github_login`, ''), `avatar_url`, 1, COALESCE(`cached_at`, unixepoch()), `cached_at`
	FROM `local_user` WHERE `id` = 1;--> statement-breakpoint
INSERT OR IGNORE INTO `accounts` (`id`, `github_user_id`, `github_login`, `is_local`, `created_at`)
	VALUES (1, '', '', 1, unixepoch());--> statement-breakpoint
ALTER TABLE `repos` ADD `account_id` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `account_id` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `account_id` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `claude_reviews` ADD `account_id` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `my_turn_dismissals` ADD `account_id` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
DROP INDEX `repos_github_node_id_unique`;--> statement-breakpoint
DROP INDEX `repos_owner_name`;--> statement-breakpoint
DROP INDEX `pull_requests_github_node_id_unique`;--> statement-breakpoint
DROP INDEX `reviews_github_node_id_unique`;--> statement-breakpoint
DROP INDEX `review_threads_github_node_id_unique`;--> statement-breakpoint
DROP INDEX `review_comments_github_node_id_unique`;--> statement-breakpoint
DROP INDEX `pr_comments_github_node_id_unique`;--> statement-breakpoint
DROP INDEX `events_dedupe_key_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `repos_account_owner_name` ON `repos` (`account_id`,`owner`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `repos_account_node` ON `repos` (`account_id`,`github_node_id`);--> statement-breakpoint
CREATE INDEX `repos_account_idx` ON `repos` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pr_account_node` ON `pull_requests` (`account_id`,`github_node_id`);--> statement-breakpoint
CREATE INDEX `pr_account_idx` ON `pull_requests` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_pr_node` ON `reviews` (`pr_id`,`github_node_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `thread_pr_node` ON `review_threads` (`pr_id`,`github_node_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `rc_pr_node` ON `review_comments` (`pr_id`,`github_node_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `prc_pr_node` ON `pr_comments` (`pr_id`,`github_node_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_account_dedupe` ON `events` (`account_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `events_account_idx` ON `events` (`account_id`);--> statement-breakpoint
CREATE INDEX `cr_account_idx` ON `claude_reviews` (`account_id`);--> statement-breakpoint
CREATE INDEX `mtd_account_idx` ON `my_turn_dismissals` (`account_id`);--> statement-breakpoint
DROP TABLE `local_user`;
